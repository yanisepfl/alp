// Wire types shared with the frontend.

export type TokenSymbol = "USDC" | "ETH" | "BTC" | "USDT" | "UNI";

export type WireChip =
 | { type: "single"; token: TokenSymbol }
 | { type: "pair"; left: TokenSymbol; right: TokenSymbol };

export type WireSource =
 | { kind: "vault"; label: string; tx: string }
 | { kind: "basescan"; label: string; tx: string }
 | { kind: "uniswap"; label: string; url: string };

export type ActionCategory = "swap" | "edit_position" | "claim_fees";

export type WireMessage =
 | { id: string; ts: string; kind: "signal"; text: string; sources?: WireSource[] }
 | { id: string; ts: string; kind: "thought"; text: string }
 | { id: string; ts: string; kind: "action"; title: string; category: ActionCategory; chip: WireChip; tx: string; text: string; thought?: string }
 | { id: string; ts: string; kind: "user"; text: string }
 | { id: string; ts: string; kind: "reply"; text: string; replyTo?: string; sources?: WireSource[] };

export type Topic = "agent" | "vault" | "user";

// "not_subscribed" covers non-fatal user_message rejection; "rate_limited"
// covers token-bucket exhaustion on user_message. Both are recoverable —
// the connection stays open and the client retries.
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
 | { v: 1; type: "ack"; subscribed: Topic[]; rejected?: Array<{ topic: string; reason: ErrorCode }> }
 | { v: 1; type: "ping" }
 | { v: 1; type: "error"; code: ErrorCode; message: string }
 | { v: 1; type: "history"; topic: "agent"; events: WireMessage[]; cursor?: string }
 | { v: 1; type: "event"; topic: "agent"; event: WireMessage }
 | { v: 1; type: "snapshot"; topic: "vault"; snapshot: VaultSnapshot }
 | { v: 1; type: "tick"; topic: "vault"; tick: VaultTick }
 | { v: 1; type: "snapshot"; topic: "user"; snapshot: UserSnapshot };

export type ClientFrame =
 | { v: 1; type: "subscribe"; topics?: Topic[]; since?: { agent?: string }; wallet?: string }
 | { v: 1; type: "user_message"; text: string; clientId: string }
 | { v: 1; type: "unsubscribe"; topics: Topic[] };

export type VaultAllocation = {
 token: TokenSymbol;
 pct: number;
};

export type VaultPool = {
 slug: string;
 label: string;
 pct: number;
 position:
 | { kind: "pair"; left: TokenSymbol; right: TokenSymbol }
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
