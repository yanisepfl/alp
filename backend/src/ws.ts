// WebSocket connection lifecycle:
//   - mints a connection id (cid) per upgrade
//   - tracks per-connection state: subscribedTopics, wallet, lastAgentCursor
//   - dispatches subscribe / unsubscribe / user_message
//   - emits ack + per-topic priming, ping every 30s, error frames on bad input
//
// Auth: trust-on-claim. subscribe.wallet (lower-cased address) is taken at
// face value and stored on the connection; no signature verification. The
// user topic and user_message frames require a non-null state.wallet.
//
// All actual topic logic (ring, vault tick, user mock) lives in src/topics/*.

import type { ServerWebSocket } from "bun";
import type { ClientFrame, ErrorCode, StreamFrame, Topic } from "./types";
import { BadFrameError, encode, parseClientFrame, summarize } from "./frames";
import {
  subscribeAgent, unsubscribeAgent, agentHistoryFrame, handleUserMessage, bindWallet,
} from "./topics/agent";
import {
  subscribeVault, unsubscribeVault, vaultSnapshotFrame,
} from "./topics/vault";
import {
  subscribeUser, unsubscribeUser, userSnapshotFrame,
} from "./topics/user";
import { notifyForwardSubscribers } from "./ingest";

const DEBUG = (Bun.env.DEBUG_FRAMES ?? "1") === "1";
const PING_MS = 30_000;
const VALID_TOPICS: ReadonlySet<Topic> = new Set(["agent", "vault", "user"]);

// B7 — per-WS-connection token bucket on user_message frames only.
// Capacity 20, refill 1 token / 3s ⇒ 20-burst, ~20/min sustained. Subscribe /
// unsubscribe / ping are not bucketed (cheap, part of the lifecycle).
const USER_MSG_BUCKET_CAPACITY = 20;
const USER_MSG_REFILL_MS = 3_000;

// B7 — `kind` discriminator added so Bun.serve's single websocket handler
// can dispatch public /stream conns vs /ingest/stream agent conns.
export type WsData = { kind: "public"; cid: string };
type Conn = ServerWebSocket<WsData>;

type ConnState = {
  cid: string;
  ws: Conn;
  subscribedTopics: Set<Topic>;
  wallet: string | null;
  lastAgentCursor: string | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  // B7 — token bucket: tokens are floats so the refill math is monotonic and
  // doesn't need a separate timer.
  userMsgTokens: number;
  userMsgLastRefillMs: number;
};

const conns = new Map<string, ConnState>();

export function connectionCount(): number {
  return conns.size;
}

// B7 — best-effort ping to every public subscriber. Used by the graceful
// shutdown path to nudge clients toward reconnect before the process exits.
export function broadcastShutdownPing(): void {
  for (const state of conns.values()) {
    if (state.ws.readyState === 1) {
      try { send(state, { v: 1, type: "ping" }); } catch { /* dead conn */ }
    }
  }
}

// Lazy refill, computed on each user_message arrival. Returns true if a token
// was consumed; false on bucket empty (client should back off).
function consumeUserMsgToken(state: ConnState): boolean {
  const now = Date.now();
  const elapsed = now - state.userMsgLastRefillMs;
  if (elapsed > 0) {
    const refilled = elapsed / USER_MSG_REFILL_MS;
    if (refilled > 0) {
      state.userMsgTokens = Math.min(USER_MSG_BUCKET_CAPACITY, state.userMsgTokens + refilled);
      state.userMsgLastRefillMs = now;
    }
  }
  if (state.userMsgTokens >= 1) {
    state.userMsgTokens -= 1;
    return true;
  }
  return false;
}

function send(state: ConnState, frame: StreamFrame): void {
  if (DEBUG) console.log(`[ws cid=${state.cid} dir=out] ${summarize(frame)}`);
  state.ws.send(encode(frame));
}

function sendError(state: ConnState, code: ErrorCode, message: string): void {
  send(state, { v: 1, type: "error", code, message });
}

export function newCid(): string {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}

export function handleOpen(ws: Conn): void {
  const cid = ws.data.cid;
  const state: ConnState = {
    cid,
    ws,
    subscribedTopics: new Set(),
    wallet: null,
    lastAgentCursor: null,
    pingTimer: null,
    userMsgTokens: USER_MSG_BUCKET_CAPACITY,
    userMsgLastRefillMs: Date.now(),
  };
  state.pingTimer = setInterval(() => {
    if (state.ws.readyState === 1) send(state, { v: 1, type: "ping" });
  }, PING_MS);
  conns.set(cid, state);
  if (DEBUG) console.log(`[ws cid=${cid} open]`);
}

export function handleClose(ws: Conn): void {
  const cid = ws.data.cid;
  const state = conns.get(cid);
  if (!state) return;
  if (state.pingTimer) clearInterval(state.pingTimer);
  for (const t of state.subscribedTopics) detach(state, t);
  conns.delete(cid);
  if (DEBUG) console.log(`[ws cid=${cid} close]`);
}

export async function handleMessage(ws: Conn, raw: string | Buffer): Promise<void> {
  const cid = ws.data.cid;
  const state = conns.get(cid);
  if (!state) return;

  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let frame: ClientFrame | null;
  try {
    frame = parseClientFrame(text);
  } catch (e) {
    const reason = e instanceof BadFrameError ? e.reason : "bad_frame";
    if (DEBUG) console.log(`[ws cid=${cid} dir=in] bad_frame reason=${reason}`);
    sendError(state, "bad_frame", reason);
    return;
  }
  if (frame === null) {
    if (DEBUG) console.log(`[ws cid=${cid} dir=in] dropped (v!==1)`);
    return; // silent drop per contract §7
  }

  if (DEBUG) console.log(`[ws cid=${cid} dir=in] ${summarize(frame)}`);

  switch (frame.type) {
    case "subscribe":    await handleSubscribe(state, frame); break;
    case "unsubscribe":  handleUnsubscribe(state, frame); break;
    case "user_message": handleUserMsg(state, frame); break;
  }
}

function deliver(state: ConnState): (f: StreamFrame) => void {
  return (f) => send(state, f);
}

function attach(state: ConnState, t: Topic): void {
  switch (t) {
    case "agent": subscribeAgent(state.cid, state.wallet, deliver(state)); break;
    case "vault": subscribeVault(state.cid, deliver(state)); break;
    case "user":  subscribeUser(state.cid, state.wallet!, deliver(state)); break;
  }
}

function detach(state: ConnState, t: Topic): void {
  switch (t) {
    case "agent": unsubscribeAgent(state.cid); break;
    case "vault": unsubscribeVault(state.cid); break;
    case "user":  unsubscribeUser(state.cid); break;
  }
}

async function handleSubscribe(
  state: ConnState,
  frame: Extract<ClientFrame, { type: "subscribe" }>,
): Promise<void> {
  // Trust-on-claim: subscribe.wallet (lower-cased address) is bound to the
  // connection without any signature verification. Absent → state.wallet
  // stays null and the user topic / user_message frames are rejected with
  // auth_required. The FE owns lifecycle (close+reopen on wallet swap).
  const claimed = typeof frame.wallet === "string" && frame.wallet.length > 0
    ? frame.wallet.toLowerCase()
    : null;
  if (claimed !== state.wallet) {
    state.wallet = claimed;
    // If we were already subscribed to agent under a different (or no)
    // wallet, rebind so future user/reply private routing keys on the
    // current claim.
    if (claimed !== null && state.subscribedTopics.has("agent")) {
      bindWallet(state.cid, claimed);
    }
  }

  const requested = (frame.topics ?? ["agent"]) as readonly Topic[];
  const subscribed: Topic[] = [];
  const rejected: Array<{ topic: string; reason: ErrorCode }> = [];
  const newlyAdded = new Set<Topic>();
  const seen = new Set<string>();

  for (const t of requested) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (!VALID_TOPICS.has(t as Topic)) {
      rejected.push({ topic: t as string, reason: "unknown_topic" });
      continue;
    }
    if (t === "user" && !state.wallet) {
      rejected.push({ topic: t, reason: "auth_required" });
      continue;
    }
    subscribed.push(t);
    if (!state.subscribedTopics.has(t)) {
      state.subscribedTopics.add(t);
      attach(state, t);
      newlyAdded.add(t);
    }
  }

  send(state, {
    v: 1, type: "ack", subscribed,
    ...(rejected.length > 0 ? { rejected } : {}),
  });

  // Priming for newly-added topics, in the order they appear in `subscribed`.
  for (const t of subscribed) {
    if (!newlyAdded.has(t)) continue;
    if (t === "agent") {
      const since = frame.since?.agent;
      const histFrame = agentHistoryFrame(since, state.wallet);
      send(state, histFrame);
      if (histFrame.type === "history" && histFrame.cursor !== undefined) {
        state.lastAgentCursor = histFrame.cursor;
      }
    } else if (t === "vault") {
      send(state, vaultSnapshotFrame());
    } else if (t === "user") {
      send(state, userSnapshotFrame(state.wallet!));
    }
  }
}

function handleUnsubscribe(
  state: ConnState,
  frame: Extract<ClientFrame, { type: "unsubscribe" }>,
): void {
  for (const t of frame.topics) {
    if (state.subscribedTopics.has(t)) {
      state.subscribedTopics.delete(t);
      detach(state, t);
    }
  }
  // No ack on unsubscribe — see README "Conventions chosen…"
}

function handleUserMsg(
  state: ConnState,
  frame: Extract<ClientFrame, { type: "user_message" }>,
): void {
  if (!state.wallet) {
    sendError(state, "auth_required", "user_message requires a wallet on subscribe");
    return;
  }
  if (!state.subscribedTopics.has("agent")) {
    sendError(state, "not_subscribed", "user_message requires an active agent subscription");
    return;
  }
  if (typeof frame.text !== "string" || typeof frame.clientId !== "string" || frame.clientId.length === 0) {
    sendError(state, "bad_frame", "user_message missing text or clientId");
    return;
  }
  // B7 — rate-limit AFTER auth/sub/shape checks so a misbehaving client
  // can't probe auth state through bucket exhaustion behaviour. Bucket
  // exhaustion emits a recoverable error; the connection stays open.
  if (!consumeUserMsgToken(state)) {
    sendError(state, "rate_limited", "user_message rate limit exceeded; retry shortly");
    return;
  }
  // B7 — fan out to any connected agent on /ingest/stream BEFORE the
  // canned-reply path so an agent server (when present) sees the message
  // exactly once per accepted user_message.
  notifyForwardSubscribers({
    wallet: state.wallet,
    clientId: frame.clientId,
    text: frame.text,
    ts: new Date().toISOString(),
  });
  handleUserMessage(state.cid, state.wallet, frame.text, frame.clientId);
}
