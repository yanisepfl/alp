// B7 — agent ingest seam.
//
// The agent server (separate, future track) lives on a private host and
// connects to this backend over a shared-secret-authenticated channel:
//
//   - POST /ingest/signal — publish a vault-global signal WireMessage.
//   - POST /ingest/reply  — publish a private reply WireMessage to a wallet.
//   - WSS  /ingest/stream — register as a forward subscriber; every accepted
//                           public user_message is forwarded as a frame.
//
// Action WireMessages are NOT publishable here — they continue to come from
// the chain via the indexer (FE clarification 4: action.tx must be a real
// on-chain hash). The seam is for signals + replies + user_message forwarding.
//
// Auth: a single shared secret in INGEST_SECRET. Constant-time compare via
// crypto.timingSafeEqual. No multi-agent role separation; one secret, any
// number of agent clients (multiple agent processes can subscribe to the
// forward stream simultaneously).

import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";

const INGEST_SECRET_RAW = Bun.env.INGEST_SECRET ?? "";

// `authed` is determined at upgrade time from the ?secret= query param. The
// ws handler closes the socket with 4001 on `authed: false` immediately
// after open — accepting then closing surfaces the failure cleanly across
// all WS clients (some don't expose 401-on-upgrade), and prevents the
// race that a pending-reject side channel would create.
export type IngestWsData = { kind: "ingest"; authed: boolean };
type IngestWs = ServerWebSocket<IngestWsData>;

type ForwardFrame = {
  v: 1;
  type: "forward";
  wallet: string;
  clientId: string;
  text: string;
  ts: string;
};

const forwardSubs = new Set<IngestWs>();

// Constant-time compare. Length mismatch short-circuits to false (we still
// run timingSafeEqual on equal-length buffers to keep the timing profile
// flat once length is verified).
export function verifyIngestSecret(presented: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (INGEST_SECRET_RAW.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(INGEST_SECRET_RAW, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerForwardSubscriber(ws: IngestWs): void {
  forwardSubs.add(ws);
}

export function unregisterForwardSubscriber(ws: IngestWs): void {
  forwardSubs.delete(ws);
}

// Fan out every accepted public user_message to every connected agent.
// If no agent is connected, this is a no-op — the user_message still gets
// the canned-reply fallback from topics/agent.ts:handleUserMessage.
// No queueing for offline agents (out of scope).
export function notifyForwardSubscribers(args: {
  wallet: string;
  clientId: string;
  text: string;
  ts: string;
}): void {
  if (forwardSubs.size === 0) return;
  const frame: ForwardFrame = {
    v: 1,
    type: "forward",
    wallet: args.wallet,
    clientId: args.clientId,
    text: args.text,
    ts: args.ts,
  };
  const payload = JSON.stringify(frame);
  for (const ws of forwardSubs) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch { /* dead conn cleaned on close */ }
    }
  }
}

// Boot guard. Required at start, ≥32 chars. Called from index.ts before
// the server binds.
export function assertIngestSecretConfigured(): void {
  if (!INGEST_SECRET_RAW || INGEST_SECRET_RAW.length < 32) {
    console.error("FATAL: INGEST_SECRET env var is required (min 32 chars). Generate with: openssl rand -base64 48");
    process.exit(1);
  }
}
