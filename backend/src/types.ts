// Wire types lifted verbatim from alp/CONTRACT.md v1.
// Section markers below mirror the contract.

// ============================================================
// Reused from lib/agent-stream.ts (existing wire framework)
// ============================================================

export type TokenSymbol = "USDC" | "ETH" | "BTC" | "USDT" | "UNI";

export type WireChip =
  | { type: "single"; token: TokenSymbol }
  | { type: "pair"; left: TokenSymbol; right: TokenSymbol };

export type WireSource =
  | { kind: "vault";    label: string; tx: string }
  | { kind: "basescan"; label: string; tx: string }
  | { kind: "uniswap";  label: string; url: string };

export type ActionCategory = "swap" | "edit_position" | "claim_fees";

export type WireMessage =
  | { id: string; ts: string; kind: "signal";  text: string; sources?: WireSource[] }
  | { id: string; ts: string; kind: "action";  title: string; category: ActionCategory; chip: WireChip; tx: string; text: string; thought?: string }
  | { id: string; ts: string; kind: "user";    text: string }
  | { id: string; ts: string; kind: "reply";   text: string; replyTo?: string; sources?: WireSource[] };

// ============================================================
// §3 — Frame envelopes
// ============================================================

export type Topic = "agent" | "vault" | "user";

// Contract lists 6 codes; "not_subscribed" is an extension confirmed by FE
// lead 2026-04-29 for non-fatal user_message rejection. "rate_limited" is
// a B7 extension — token-bucket exhaustion on user_message. Recoverable,
// non-fatal: client retries after a brief pause.
export type ErrorCode =
  | "auth_required"
  | "auth_invalid"
  | "forbidden"
  | "unknown_topic"
  | "bad_frame"
  | "internal"
  | "not_subscribed"
  | "rate_limited";

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
  | { v: 1; type: "subscribe";    topics?: Topic[]; since?: { agent?: string }; wallet?: string }
  | { v: 1; type: "user_message"; text: string; clientId: string }
  | { v: 1; type: "unsubscribe";  topics: Topic[] };

// ============================================================
// §4.1 — Vault
// ============================================================

export type VaultAllocation = {
  token: TokenSymbol;
  pct: number;
};

export type VaultPool = {
  slug: string;
  label: string;
  pct: number;
  position:
    | { kind: "pair";   left: TokenSymbol; right: TokenSymbol }
    | { kind: "single"; token: TokenSymbol };
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

// ============================================================
// §4.2 — User
// ============================================================

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
