// ALP backend wire types — see ../../../CONTRACT.md.
//
// This module is the source of truth for data-layer types consumed by
// the UI. The chat-message shapes live in `agent-stream.ts` (shared
// with the backend); we re-export rather than duplicate so a single
// edit there propagates here.

import type {
  ActionCategory,
  TokenSymbol,
  WireChip,
  WireMessage,
  WireSource,
} from "@/lib/agent-stream";

export type {
  ActionCategory,
  TokenSymbol,
  WireChip,
  WireMessage,
  WireSource,
};

// ---- Topic & error ----

export type Topic = "agent" | "vault" | "user";

// Wire error codes. Three doctrines coexist on the wire:
//
//   1. `ack.rejected[].reason` — a *recoverable* per-topic rejection.
//      The connection stays open; other topics in the same subscribe
//      can still be accepted. Backend convention (B7) uses this for
//      `auth_required` on the user topic.
//   2. `error` frame — a *non-fatal* server-side error. Connection
//      stays open. Examples: `not_subscribed` / `rate_limited` from a
//      user_message that arrived too early or too fast.
//   3. WS close code (4001 / 4003 / 4400) — *fatal* for this socket.
//      Distinct from the codes here; see ApiClient close handling.
export type ErrorCode =
  | "auth_required"
  | "auth_invalid"
  | "forbidden"
  | "unknown_topic"
  | "bad_frame"
  | "not_subscribed"
  | "rate_limited"
  | "internal";

export type ApiError = {
  code: ErrorCode;
  message: string;
};

// ---- Vault payloads ----

export type VaultAllocation = {
  token: TokenSymbol;
  pct: number;
};

export type VaultPoolPosition =
  | { kind: "pair";   left: TokenSymbol; right: TokenSymbol }
  | { kind: "single"; token: TokenSymbol };

export type VaultPool = {
  slug: string;
  label: string;
  pct: number;
  position: VaultPoolPosition;
  apr: number;
  earned30d: number;
};

export type VaultSnapshot = {
  address: string;
  chainId: 8453;

  sharePrice: number;
  tvl: number;
  basketApr: number;
  basketEarned30d: number;
  users: number;

  sharePrice30d: number[];
  tvl30d: number[];
  apr30d: number[];

  allocations: VaultAllocation[];
  pools: VaultPool[];

  ts: string;
};

export type VaultTick = {
  ts: string;
  sharePrice?: number;
  tvl?: number;
  basketApr?: number;
  basketEarned30d?: number;
  users?: number;
  sharePrice30d?: number[];
  tvl30d?: number[];
  apr30d?: number[];
  allocations?: VaultAllocation[];
  pools?: VaultPool[];
};

// ---- User payloads ----

export type UserPosition = {
  shares: string;
  valueUsd: number;
  costBasisSharePrice: number;
  totalDepositedUsd: number;
  firstDepositTs: string;
  pnlUsd: number;
  pnlPct: number;
  realizedApyPct: number;
};

export type UserActivityRow = {
  id: string;
  kind: "deposit" | "withdraw";
  amount: number;
  token: TokenSymbol;
  ts: string;
  tx: string;
};

export type UserSnapshot = {
  wallet: string;
  position: UserPosition | null;
  activity: UserActivityRow[];
  ts: string;
};

// ---- Frame unions ----

export type StreamFrame =
  | { v: 1; type: "ack";      subscribed: Topic[]; rejected?: Array<{ topic: string; reason: ErrorCode }> }
  | { v: 1; type: "ping" }
  | { v: 1; type: "error";    code: ErrorCode; message: string }
  | { v: 1; type: "history";  topic: "agent"; events: WireMessage[]; cursor?: string }
  | { v: 1; type: "event";    topic: "agent"; event: WireMessage }
  | { v: 1; type: "snapshot"; topic: "vault"; snapshot: VaultSnapshot }
  | { v: 1; type: "tick";     topic: "vault"; tick: VaultTick }
  | { v: 1; type: "snapshot"; topic: "user";  snapshot: UserSnapshot };

export type ClientFrame =
  | {
      v: 1;
      type: "subscribe";
      topics?: Topic[];
      since?: { agent?: string };
      auth?: string;
    }
  | {
      v: 1;
      type: "user_message";
      text: string;
      clientId: string;
    }
  | {
      v: 1;
      type: "unsubscribe";
      topics: Topic[];
    };

// ---- Client-facing handler shapes ----
//
// Both the real WSS client and the dev stub satisfy `ApiClient`. Hooks
// program against this surface, never the underlying transport.

// `onError` carries any server-side error we've routed to this topic
// — `ack.rejected` reasons or `error` frames whose code maps to the
// topic (e.g. `auth_required` → user, `rate_limited` → agent). The
// connection is still open; the consumer decides whether to retry,
// render a CTA, or back off.
export type AgentHandlers = {
  onHistory?: (events: WireMessage[], cursor?: string) => void;
  onEvent?: (event: WireMessage) => void;
  onError?: (error: ApiError) => void;
};

export type VaultHandlers = {
  onSnapshot?: (snap: VaultSnapshot) => void;
  onTick?: (tick: VaultTick) => void;
  onError?: (error: ApiError) => void;
};

export type UserHandlers = {
  onSnapshot?: (snap: UserSnapshot) => void;
  onError?: (error: ApiError) => void;
};

export type Unsubscribe = () => void;

// sendUserMessage is sync. The wire send happens immediately if the
// socket is OPEN; downstream server-side rejection (rate_limited /
// not_subscribed) arrives later as an error frame and surfaces
// through `subscribeAgent({ onError })`.
export type SendResult =
  | { ok: true; clientId: string }
  | { ok: false; reason: "disconnected" };

export type ApiClient = {
  subscribeAgent(handlers: AgentHandlers): Unsubscribe;
  subscribeVault(handlers: VaultHandlers): Unsubscribe;
  subscribeUser(handlers: UserHandlers): Unsubscribe;

  // Returns the clientId echoed back as WireMessage.id for optimistic
  // reconciliation — the server persists the user frame with
  // id === clientId so the echoed event matches the local row. When
  // the socket isn't OPEN the call is honest about the drop so the
  // composer can keep the typed text and surface inline feedback.
  sendUserMessage(text: string): SendResult;

  // SIWE JWT pass-through. Setting it (re)issues the subscribe frame
  // on the existing connection so the server upgrades the principal
  // without reconnecting. Wired from wagmi state once SIWE flows land.
  setAuthToken(token: string | undefined): void;

  // Drop the current socket and reopen. Backend convention (B7
  // "Conventions chosen where the contract is silent"): the wallet
  // does not switch mid-connection — re-subscribing with a different
  // token while already authed is logged-and-ignored. The recovery
  // is to reconnect, which is what wallet-swap and disconnect cases
  // need. agentCursor is preserved across the reconnect so the user
  // doesn't see a full history replay.
  forceReconnect(): void;

  close(): void;
};
