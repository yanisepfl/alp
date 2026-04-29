// Backend session-token mint via EIP-4361 Sign-In with Ethereum.
//
// Flow (matches backend "Auth (SIWE)"):
//   1. GET  /auth/nonce          → { nonce }
//   2. Build a SIWE message bound to (domain, uri, chainId 8453, nonce)
//   3. wagmi signMessage(message) → signature   (passed in by caller)
//   4. POST /auth/verify         → { token, wallet, exp }
//
// Phase 7c implementation. The public surface (`AuthSession`,
// `getAuthSession`, `deriveAuthBaseUrl`) is unchanged from 7b so the
// auth bridge and the rest of the data layer don't need to move.
//
// Why a `signMessage` callback instead of importing wagmi here:
// signing must happen on the user's wallet via the React-bound
// wagmi context (`useSignMessage` → `signMessageAsync`). Hooks
// can't be called inside an async function, so the bridge owns
// the hook and passes a thin adapter down.

import { SiweMessage } from "siwe";
import { getAddress } from "viem";

export type AuthSession = {
  token: string;
  wallet: string;
  // Unix epoch seconds, per backend's JWT payload `exp`.
  exp: number;
};

// Discriminated error type so the bridge can decide whether to
// retry, log, or fall through to the auth_required CTA. Mirrors
// backend's 400/401 error matrix plus a wagmi user-cancel case.
export type AuthErrorReason =
  | "user_rejected"      // wagmi UserRejectedRequestError — wallet popup cancelled
  | "wrong_chain"        // backend 400 wrong_chain (shouldn't fire — we hardcode 8453)
  | "wrong_domain"       // backend 400 wrong_domain — config mismatch (fatal)
  | "bad_nonce"          // backend 400 bad_nonce — recoverable, retry once
  | "bad_signature"      // backend 401 bad_signature — recoverable, retry once
  | "network"            // fetch failed / non-recognised status
  | "unknown";           // anything else

export class AuthError extends Error {
  constructor(public reason: AuthErrorReason, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// Signer adapter the bridge passes in. wagmi's signMessageAsync has
// a slightly different signature; the bridge wraps it.
export type SignMessageFn = (message: string) => Promise<string>;

// Derive the HTTP origin the backend's auth endpoints live on from
// the WSS URL, since they share host:port. `wss://host/stream` →
// `https://host`. The override env (`NEXT_PUBLIC_SHERPA_AUTH_URL`)
// is for deployments where TLS termination splits the auth host
// from the WSS host (uncommon, but Caddy/nginx flexibility).
export function deriveAuthBaseUrl(wssUrl: string): string {
  const override = process.env.NEXT_PUBLIC_SHERPA_AUTH_URL;
  if (override) return override.replace(/\/+$/, "");
  const u = new URL(wssUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}`;
}

function authBaseOrThrow(): string {
  const wssUrl = process.env.NEXT_PUBLIC_SHERPA_WSS_URL;
  if (!wssUrl) {
    throw new AuthError("network", "NEXT_PUBLIC_SHERPA_WSS_URL not set; cannot derive auth base URL");
  }
  return deriveAuthBaseUrl(wssUrl);
}

// Wagmi/viem throws a typed UserRejectedRequestError on popup
// cancel; downstream wallet plumbing sometimes wraps it. We sniff
// `name`, `cause.name`, and EIP-1193 code 4001 to cover all paths.
function isUserRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: number; cause?: { name?: string; code?: number } };
  if (e.name === "UserRejectedRequestError") return true;
  if (e.code === 4001) return true;
  if (e.cause?.name === "UserRejectedRequestError") return true;
  if (e.cause?.code === 4001) return true;
  return false;
}

async function fetchNonce(base: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base}/auth/nonce`);
  } catch (err) {
    throw new AuthError("network", `nonce fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new AuthError("network", `nonce ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { nonce?: string };
  if (!json.nonce) throw new AuthError("network", "nonce response missing `nonce`");
  return json.nonce;
}

// Build the canonical EIP-4361 message string. Domain/uri come from
// the live `window.location` so dev (localhost:3000) matches backend
// defaults out of the box. chainId is hardcoded to 8453 (Base) per
// CONTRACT §1. The address must be EIP-55 checksum-cased — siwe@3
// rejects lowercase. The bridge lowercases the address for state
// comparison, so we re-checksum here via viem rather than thread an
// extra param through the bridge.
function buildSiweMessage(address: string, nonce: string): string {
  const msg = new SiweMessage({
    domain: window.location.host,
    address: getAddress(address),
    statement: "Sign in to Alphix ALP.",
    uri: window.location.origin,
    version: "1",
    chainId: 8453,
    nonce,
    issuedAt: new Date().toISOString(),
  });
  return msg.prepareMessage();
}

async function postVerify(base: string, message: string, signature: string): Promise<AuthSession> {
  let res: Response;
  try {
    res = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
  } catch (err) {
    throw new AuthError("network", `verify fetch failed: ${(err as Error).message}`);
  }
  if (res.ok) {
    const json = (await res.json()) as { token: string; wallet: string; exp: number };
    if (!json.token || !json.wallet || typeof json.exp !== "number") {
      throw new AuthError("network", "verify response missing token/wallet/exp");
    }
    return json;
  }
  // Backend error matrix: body is plain text or JSON with the code
  // word the README documents (wrong_chain | wrong_domain | bad_nonce
  // | bad_signature). Sniff the body so the bridge can branch.
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  const text = body.toLowerCase();
  if (text.includes("wrong_chain"))    throw new AuthError("wrong_chain",   `verify 400 wrong_chain: ${body}`);
  if (text.includes("wrong_domain"))   throw new AuthError("wrong_domain",  `verify 400 wrong_domain: ${body} (frontend host=${window.location.host})`);
  if (text.includes("bad_nonce"))      throw new AuthError("bad_nonce",     `verify 400 bad_nonce: ${body}`);
  if (text.includes("bad_signature"))  throw new AuthError("bad_signature", `verify 401 bad_signature: ${body}`);
  throw new AuthError("network", `verify ${res.status}: ${body || res.statusText}`);
}

// Run the SIWE flow once. Returns a session on success; throws
// AuthError otherwise. The `bad_nonce` / `bad_signature` retry
// behaviour lives at the public `getAuthSession` layer below.
async function runSiweOnce(address: string, signMessage: SignMessageFn): Promise<AuthSession> {
  const base = authBaseOrThrow();
  const nonce = await fetchNonce(base);
  const message = buildSiweMessage(address, nonce);
  let signature: string;
  try {
    signature = await signMessage(message);
  } catch (err) {
    if (isUserRejection(err)) {
      throw new AuthError("user_rejected", "wallet signature cancelled");
    }
    throw new AuthError("unknown", `signMessage failed: ${(err as Error).message ?? String(err)}`);
  }
  return postVerify(base, message, signature);
}

// Public surface. Mints a session for `address` via SIWE.
//
// Retry policy: `bad_nonce` (consumed/expired between fetch and
// verify) and `bad_signature` (rare; user signed a stale draft) are
// each retried once with a fresh nonce + fresh signature. All other
// errors propagate to the caller. User-cancel is never retried.
export async function getAuthSession(address: string, signMessage: SignMessageFn): Promise<AuthSession> {
  try {
    return await runSiweOnce(address, signMessage);
  } catch (err) {
    if (err instanceof AuthError && (err.reason === "bad_nonce" || err.reason === "bad_signature")) {
      return runSiweOnce(address, signMessage);
    }
    throw err;
  }
}

// Test/dev helper — NOT the production auth path. The bridge no
// longer calls this; it's exported only so integration scripts can
// mint a token without a wallet popup. Backend returns 404 unless
// `AUTH_DEV_BYPASS=1` is set, so this fails closed in production.
export async function getDevToken(address: string): Promise<AuthSession> {
  const base = authBaseOrThrow();
  const res = await fetch(`${base}/auth/dev-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: address }),
  });
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }
    if (res.status === 404) {
      throw new AuthError("network", "dev-token endpoint disabled (AUTH_DEV_BYPASS=0)");
    }
    throw new AuthError("network", `dev-token ${res.status}: ${body || res.statusText}`);
  }
  const json = (await res.json()) as { token: string; wallet: string; exp: number };
  if (!json.token || !json.wallet || typeof json.exp !== "number") {
    throw new AuthError("network", "dev-token response missing token/wallet/exp");
  }
  return json;
}
