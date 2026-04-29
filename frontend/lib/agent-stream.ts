// Sherpa chat wire protocol — presentation-free types shared with
// the backend.
//
// Wire is presentation-free: ISO-8601 timestamps, token symbols,
// tx hashes (no explorer URLs). View layer adapts.
//
// Auth: SIWE on connect → session JWT → first WSS frame is
// `subscribe` with `auth: <jwt>`. Server binds wallet to connection
// and ignores any client-supplied `wallet` field on user messages.

export type TokenSymbol = "USDC" | "ETH" | "BTC" | "USDT" | "UNI";

export type WireChip =
  | { type: "single"; token: TokenSymbol }
  | { type: "pair"; left: TokenSymbol; right: TokenSymbol };

// vault/basescan: tx hash, frontend builds explorer URL.
// uniswap: app URL (pool pages aren't tx-derived).
export type WireSource =
  | { kind: "vault";    label: string; tx: string }
  | { kind: "basescan"; label: string; tx: string }
  | { kind: "uniswap";  label: string; url: string };

// `id` is server-issued ULID, EXCEPT for `user` events: the server
// MUST persist user_message frames with id === clientId so the
// echoed event reconciles with the optimistic local row by id.
// `ts` is ISO-8601.
// `wallet` deliberately omitted from `user` — the server binds the
// wallet to the connection from the SIWE-bound JWT, not from the body.
// Action `category` lets surfaces show short, kind-aware titles
// (e.g. "Swap", "Claim fees") without parsing the body text.
export type ActionCategory = "swap" | "edit_position" | "claim_fees";

export type WireMessage =
  | { id: string; ts: string; kind: "signal";  text: string }
  | { id: string; ts: string; kind: "action";  title: string; category: ActionCategory; chip: WireChip; tx: string; text: string; thought?: string }
  | { id: string; ts: string; kind: "user";    text: string }
  | { id: string; ts: string; kind: "reply";   text: string; replyTo?: string; sources?: WireSource[] };

// Idempotency key for user_message frames — server echoes it on the
// persisted event so optimistic UI rows reconcile by id.
export function clientId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
