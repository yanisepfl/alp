// HTTPS auth routes mounted on the same Bun.serve as /health and /stream.
//
//   GET  /auth/nonce      → { nonce }
//   POST /auth/verify     → SIWE message + signature → { token, wallet, exp }
//   POST /auth/dev-token  → { wallet } → { token, wallet, exp }   (gated)
//
// Dev-bypass (POST /auth/dev-token) returns 404 unless AUTH_DEV_BYPASS=1.
// MUST be off in production — see README.

import { Hono } from "hono";
import { SiweMessage } from "siwe";
import {
  consumeNonce, issueNonce, mintJwt,
  EXPECTED_DOMAIN, EXPECTED_URI,
} from "../auth";

const BASE_CHAIN_ID = 8453;
const DEV_BYPASS = (Bun.env.AUTH_DEV_BYPASS ?? "0") === "1";

export function buildAuthRoutes(): Hono {
  const r = new Hono();

  r.get("/nonce", (c) => c.json({ nonce: issueNonce() }));

  r.post("/verify", async (c) => {
    let body: { message?: unknown; signature?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_body" }, 400);
    }
    if (typeof body.message !== "string" || typeof body.signature !== "string") {
      return c.json({ error: "bad_body" }, 400);
    }

    let siwe: SiweMessage;
    try {
      siwe = new SiweMessage(body.message);
    } catch {
      return c.json({ error: "bad_message" }, 400);
    }

    if (siwe.chainId !== BASE_CHAIN_ID) {
      return c.json({ error: "wrong_chain" }, 400);
    }
    if (siwe.domain !== EXPECTED_DOMAIN) {
      return c.json({ error: "wrong_domain" }, 400);
    }
    if (!siwe.uri.startsWith(EXPECTED_URI)) {
      return c.json({ error: "wrong_domain" }, 400);
    }
    if (!consumeNonce(siwe.nonce)) {
      return c.json({ error: "bad_nonce" }, 400);
    }

    let ok = false;
    try {
      const result = await siwe.verify({ signature: body.signature });
      ok = result.success;
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "bad_signature" }, 401);

    const { token, exp } = await mintJwt(siwe.address);
    return c.json({ token, wallet: siwe.address, exp });
  });

  r.post("/dev-token", async (c) => {
    if (!DEV_BYPASS) return c.notFound();
    let body: { wallet?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_body" }, 400);
    }
    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return c.json({ error: "bad_wallet" }, 400);
    }
    const { token, exp } = await mintJwt(wallet);
    return c.json({ token, wallet, exp });
  });

  return r;
}
