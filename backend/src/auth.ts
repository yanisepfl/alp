// SIWE nonce store + JWT mint/verify.
//
// State:
//   - `nonces`: nonce -> { issuedAt, consumed }, swept every 60s, 10min TTL.
//     B6 — also mirrored to sqlite so a recently-issued nonce survives a
//     server bounce. The in-memory map is the hot path; the db is consulted
//     on consume only when the in-memory entry is missing (process restart).
//   - JWT secret/TTL/expected domain+uri loaded once from env at module import.

import { SignJWT, jwtVerify } from "jose";
import {
  consumeAuthNonceDb, insertAuthNonce, loadActiveAuthNonces, pruneAuthNoncesBefore,
} from "./db";

const NONCE_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const JWT_TTL_SECONDS = Number(Bun.env.JWT_TTL_SECONDS ?? 86400);
const JWT_SECRET_RAW = Bun.env.JWT_SECRET ?? "";
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);

export const EXPECTED_DOMAIN = Bun.env.EXPECTED_DOMAIN ?? "localhost:3000";
export const EXPECTED_URI = Bun.env.EXPECTED_URI ?? "http://localhost:3000";

type NonceEntry = { issuedAt: number; consumed: boolean };
const nonces = new Map<string, NonceEntry>();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function issueNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = base64url(bytes);
  const issuedAt = Date.now();
  nonces.set(nonce, { issuedAt, consumed: false });
  insertAuthNonce(nonce, issuedAt);
  return nonce;
}

export function consumeNonce(nonce: string): boolean {
  const entry = nonces.get(nonce);
  if (entry) {
    if (entry.consumed) return false;
    if (Date.now() - entry.issuedAt > NONCE_TTL_MS) {
      nonces.delete(nonce);
      return false;
    }
    entry.consumed = true;
    // Persist the consumed flag so a server bounce can't replay this nonce.
    consumeAuthNonceDb(nonce);
    return true;
  }
  // Miss in memory but row may exist in db — happens when a nonce issued by
  // a previous process is presented after restart. consumeAuthNonceDb returns
  // true iff the row exists and was unconsumed; it also flips the flag.
  return consumeAuthNonceDb(nonce);
}

// B6 — boot rehydration. Pulls unexpired rows from sqlite into the in-memory
// map so consume() short-circuits in the hot path. Idempotent.
let nonceStateLoaded = false;
export function loadAuthState(): void {
  if (nonceStateLoaded) return;
  nonceStateLoaded = true;
  const cutoff = Date.now() - NONCE_TTL_MS;
  pruneAuthNoncesBefore(cutoff);
  const rows = loadActiveAuthNonces(cutoff);
  for (const r of rows) nonces.set(r.nonce, { issuedAt: r.issuedAtMs, consumed: r.consumed });
  if (rows.length > 0) console.log(`[auth] loaded ${rows.length} active nonces from sqlite`);
}

let sweeperStarted = false;
export function startNonceSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [n, e] of nonces) {
      if (now - e.issuedAt > NONCE_TTL_MS) nonces.delete(n);
    }
    pruneAuthNoncesBefore(now - NONCE_TTL_MS);
  }, SWEEP_INTERVAL_MS);
}

export async function mintJwt(wallet: string): Promise<{ token: string; exp: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(JWT_SECRET);
  return { token, exp };
}

export async function verifyJwt(
  token: string,
): Promise<{ sub: string; exp: number } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp !== "number") return null;
    return { sub: payload.sub, exp: payload.exp };
  } catch {
    return null;
  }
}
