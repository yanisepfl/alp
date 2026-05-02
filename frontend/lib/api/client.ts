// Multiplexed WSS client for the ALP backend.
//
// One connection per tab carries all three topics (agent / vault /
// user). Reconnect uses cursor-based history replay + exponential
// backoff; per-topic dispatch and cached priming-frame replay let
// late subscribers (e.g. components mounting after the first
// snapshot) see state without waiting for the next backend push.
//
// Auth model: trust-on-claim. The subscribe frame includes a
// `wallet` field carrying the lower-cased connected address; backend
// binds the connection's principal to that wallet for user-topic
// delivery and Sherpa rate-limit accounting. Every served field is
// derivable from public chain anyway, so verifying wallet ownership
// doesn't gate any private data.
//
// Recoverable-error doctrine:
//
// - `ack.rejected[]` carries per-topic recoverable failures from a
// subscribe frame. Other topics in the same frame can still be
// accepted; the connection stays open. Dispatched to the rejected
// topic's `onError`.
// - `error` frames are non-fatal server-side errors after the
// subscribe handshake (e.g. `not_subscribed` / `rate_limited`
// from a too-early or too-fast `user_message`). Connection stays
// open; routed by code to the topic that triggered it (or to the
// top-level `onError` if no topic mapping applies).
// - WS close code 4400 (bad_frame) is fatal — a client bug — so we
// don't reconnect on it. Everything else falls through to
// exponential backoff with cursor replay.

import { clientId } from "@/lib/agent-stream";
import type {
 AgentHandlers,
 ApiClient,
 ApiError,
 ClientFrame,
 ErrorCode,
 SendResult,
 StreamFrame,
 Topic,
 Unsubscribe,
 UserHandlers,
 UserSnapshot,
 VaultHandlers,
 VaultSnapshot,
 WireMessage,
} from "./types";

export type ApiClientOptions = {
 url: string;
 // Initial wallet to bind on first connect. Optional; setWallet can
 // (re)bind later from wagmi state.
 wallet?: string;
 // Errors not bound to a specific topic (bad_frame, unknown_topic,
 // internal, plus any error frame whose code we don't know how to
 // route). Topic-bound errors flow through the topic's `onError`.
 onError?: (error: ApiError) => void;
};

const RECONNECT_CAP_MS = 10_000;
// Mirror the backend's agent ring cap (500 entries). On a
// long-lived tab the cache could otherwise grow unbounded.
const AGENT_RING_CAP = 500;

// `error` frames don't carry a topic field on the wire. Map by code
// to the topic that originated the error so the relevant consumer
// can react. Codes not in this map are top-level (see ApiClientOptions.onError).
const ERROR_TOPIC: Partial<Record<ErrorCode, Topic>> = {
 auth_required: "user",
 not_subscribed: "agent",
 rate_limited: "agent",
};

export function createApiClient(opts: ApiClientOptions): ApiClient {
 let wallet = opts.wallet;

 const agentListeners = new Set<AgentHandlers>();
 const vaultListeners = new Set<VaultHandlers>();
 const userListeners = new Set<UserHandlers>();

 // Cached priming state — replayed to late subscribers and rebroadcast
 // after reconnects so consumers don't see a flash of `undefined`.
 const agentMessages: WireMessage[] = [];
 let agentCursor: string | undefined;
 let vaultSnapshot: VaultSnapshot | undefined;
 let userSnapshot: UserSnapshot | undefined;

 let ws: WebSocket | null = null;
 let manuallyClosed = false;
 let retry = 0;

 const desiredTopics = (): Topic[] => {
 const t: Topic[] = ["agent", "vault"];
 if (wallet) t.push("user");
 return t;
 };

 const sendFrame = (frame: ClientFrame): boolean => {
 if (ws && ws.readyState === WebSocket.OPEN) {
 ws.send(JSON.stringify(frame));
 return true;
 }
 return false;
 };

 const issueSubscribe = () => {
 sendFrame({
 v: 1,
 type: "subscribe",
 topics: desiredTopics(),
 since: agentCursor ? { agent: agentCursor } : undefined,
 wallet,
 });
 };

 const dispatchError = (topic: Topic | undefined, err: ApiError) => {
 if (topic === "agent") {
 for (const h of agentListeners) h.onError?.(err);
 return;
 }
 if (topic === "vault") {
 for (const h of vaultListeners) h.onError?.(err);
 return;
 }
 if (topic === "user") {
 for (const h of userListeners) h.onError?.(err);
 return;
 }
 opts.onError?.(err);
 };

 const handleFrame = (frame: StreamFrame) => {
 switch (frame.type) {
 case "ack": {
 const rejected = frame.rejected ?? [];
 for (const r of rejected) {
 const topic = (["agent", "vault", "user"] as Topic[]).includes(r.topic as Topic)
 ? (r.topic as Topic)
 : undefined;
 dispatchError(topic, { code: r.reason, message: `topic ${r.topic} rejected: ${r.reason}` });
 }
 return;
 }
 case "ping":
 return;
 case "error": {
 const topic = ERROR_TOPIC[frame.code];
 dispatchError(topic, { code: frame.code, message: frame.message });
 return;
 }
 case "history": {
 agentCursor = frame.cursor ?? agentCursor;
 for (const e of frame.events) {
 if (!agentMessages.some((m) => m.id === e.id)) agentMessages.push(e);
 }
 if (agentMessages.length > AGENT_RING_CAP) {
 agentMessages.splice(0, agentMessages.length - AGENT_RING_CAP);
 }
 for (const h of agentListeners) h.onHistory?.(frame.events, frame.cursor);
 return;
 }
 case "event": {
 agentCursor = frame.event.id;
 if (!agentMessages.some((m) => m.id === frame.event.id)) {
 agentMessages.push(frame.event);
 if (agentMessages.length > AGENT_RING_CAP) {
 agentMessages.splice(0, agentMessages.length - AGENT_RING_CAP);
 }
 }
 for (const h of agentListeners) h.onEvent?.(frame.event);
 return;
 }
 case "snapshot": {
 if (frame.topic === "vault") {
 vaultSnapshot = frame.snapshot;
 for (const h of vaultListeners) h.onSnapshot?.(frame.snapshot);
 } else {
 userSnapshot = frame.snapshot;
 for (const h of userListeners) h.onSnapshot?.(frame.snapshot);
 }
 return;
 }
 case "tick": {
 for (const h of vaultListeners) h.onTick?.(frame.tick);
 return;
 }
 }
 };

 const connect = () => {
 if (manuallyClosed) return;
 ws = new WebSocket(opts.url);
 ws.addEventListener("open", () => {
 retry = 0;
 issueSubscribe();
 });
 ws.addEventListener("message", (e) => {
 let frame: StreamFrame;
 try { frame = JSON.parse(e.data) as StreamFrame; } catch { return; }
 if (!frame || frame.v !== 1) return;
 handleFrame(frame);
 });
 ws.addEventListener("close", (e) => {
 if (manuallyClosed) return;
 // 4400 (bad_frame) means the client sent something malformed —
 // reconnecting won't fix that. Everything else: exponential
 // backoff with cursor replay.
 if (e.code === 4400) return;
 const delay = Math.min(RECONNECT_CAP_MS, 500 * Math.pow(2, retry++));
 window.setTimeout(connect, delay);
 });
 };
 connect();

 return {
 subscribeAgent(handlers: AgentHandlers): Unsubscribe {
 agentListeners.add(handlers);
 if (agentMessages.length > 0) {
 // Replay cached history synchronously — caller doesn't have to
 // wait for the next backend push.
 queueMicrotask(() => handlers.onHistory?.(agentMessages.slice(), agentCursor));
 }
 return () => { agentListeners.delete(handlers); };
 },

 subscribeVault(handlers: VaultHandlers): Unsubscribe {
 vaultListeners.add(handlers);
 if (vaultSnapshot) {
 const snap = vaultSnapshot;
 queueMicrotask(() => handlers.onSnapshot?.(snap));
 }
 return () => { vaultListeners.delete(handlers); };
 },

 subscribeUser(handlers: UserHandlers): Unsubscribe {
 userListeners.add(handlers);
 if (userSnapshot) {
 const snap = userSnapshot;
 queueMicrotask(() => handlers.onSnapshot?.(snap));
 }
 return () => { userListeners.delete(handlers); };
 },

 sendUserMessage(text: string): SendResult {
 const cid = clientId();
 const sent = sendFrame({ v: 1, type: "user_message", text, clientId: cid });
 if (!sent) return { ok: false, reason: "disconnected" };
 return { ok: true, clientId: cid };
 },

 setWallet(next: string | undefined): void {
 const prev = wallet;
 wallet = next;
 if (prev !== next) {
 userSnapshot = undefined;
 // Re-issue subscribe on the existing connection. The bridge
 // calls forceReconnect after this for transitions where the
 // backend can't safely upgrade in-place (wallet swap, anon
 // pickup), so the followup ensures the new socket carries
 // `wallet` from frame zero.
 if (ws && ws.readyState === WebSocket.OPEN) issueSubscribe();
 }
 },

 forceReconnect(): void {
 userSnapshot = undefined;
 retry = 0;
 if (ws && ws.readyState !== WebSocket.CLOSED) {
 ws.close();
 } else {
 connect();
 }
 },

 close(): void {
 manuallyClosed = true;
 ws?.close();
 },
 };
}
