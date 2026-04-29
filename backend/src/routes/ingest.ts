// B7 — agent ingest HTTP routes.
//
//   POST /ingest/signal  — { text, ts? }              → { id }
//   POST /ingest/reply   — { wallet, text, replyTo?, sources?, ts? } → { id }
//
// Auth: Authorization: Bearer <INGEST_SECRET>. Constant-time compare.
// CORS deliberately NOT enabled — these endpoints are private-host only.

import { Hono } from "hono";
import type { WireSource } from "../types";
import { publishIngestSignal, publishIngestReply } from "../topics/agent";
import { verifyIngestSecret } from "../ingest";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

function checkAuth(authz: string | undefined): boolean {
  if (typeof authz !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  if (!m) return false;
  return verifyIngestSecret(m[1]!);
}

function isValidIsoTs(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function isWireSourceArray(x: unknown): x is WireSource[] {
  if (!Array.isArray(x)) return false;
  for (const s of x) {
    if (s === null || typeof s !== "object") return false;
    const k = (s as { kind?: unknown }).kind;
    if (k === "vault" || k === "basescan") {
      const o = s as { kind: string; label?: unknown; tx?: unknown };
      if (typeof o.label !== "string" || typeof o.tx !== "string") return false;
    } else if (k === "uniswap") {
      const o = s as { kind: string; label?: unknown; url?: unknown };
      if (typeof o.label !== "string" || typeof o.url !== "string") return false;
    } else {
      return false;
    }
  }
  return true;
}

export function buildIngestRoutes(): Hono {
  const r = new Hono();

  r.post("/signal", async (c) => {
    if (!checkAuth(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: { text?: unknown; ts?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_body" }, 400);
    }
    if (typeof body.text !== "string" || body.text.length === 0) {
      return c.json({ error: "bad_body" }, 400);
    }
    if (body.ts !== undefined && !isValidIsoTs(body.ts)) {
      return c.json({ error: "bad_ts" }, 400);
    }
    const id = publishIngestSignal(body.text, body.ts as string | undefined);
    return c.json({ id });
  });

  r.post("/reply", async (c) => {
    if (!checkAuth(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: { wallet?: unknown; text?: unknown; replyTo?: unknown; sources?: unknown; ts?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_body" }, 400);
    }
    if (typeof body.wallet !== "string" || !WALLET_RE.test(body.wallet)) {
      return c.json({ error: "bad_wallet" }, 400);
    }
    if (typeof body.text !== "string" || body.text.length === 0) {
      return c.json({ error: "bad_body" }, 400);
    }
    if (body.replyTo !== undefined && typeof body.replyTo !== "string") {
      return c.json({ error: "bad_replyTo" }, 400);
    }
    if (body.sources !== undefined && !isWireSourceArray(body.sources)) {
      return c.json({ error: "bad_sources" }, 400);
    }
    if (body.ts !== undefined && !isValidIsoTs(body.ts)) {
      return c.json({ error: "bad_ts" }, 400);
    }
    const id = publishIngestReply(body.wallet.toLowerCase(), body.text, {
      replyTo: body.replyTo as string | undefined,
      sources: body.sources as WireSource[] | undefined,
      ts: body.ts as string | undefined,
    });
    return c.json({ id });
  });

  return r;
}
