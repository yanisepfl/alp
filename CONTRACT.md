# ALP Backend Contract — v1

The single source of truth the backend implements against and the
frontend consumes against. Pairs with [DATA_INVENTORY.md](DATA_INVENTORY.md)
(catalogue of frontend placeholders) and [lib/agent-stream.ts](frontend/lib/agent-stream.ts)
(existing wire framework — this contract **extends** it, does not replace it).

Out of scope: backend implementation choices (db / language / infra),
wallet integration, on-chain reads, write-tx signing. TS types in this
doc are inline for review; a follow-up phase moves them into
`lib/api/types.ts` and writes the typed client.

---

## 1. Transport

A single multiplexed WebSocket Secure connection per browser tab. URL
comes from `process.env.NEXT_PUBLIC_SHERPA_WSS_URL`. Frames are
JSON-encoded objects with a numeric `v` discriminator (currently `1`)
and a `type` discriminator. All timestamps are ISO-8601 with offset.
All token symbols use `TokenSymbol` (see [agent-stream.ts:10](frontend/lib/agent-stream.ts#L10)).
**Tx hashes are full `0x`-prefixed 66-char strings** — the frontend
formats for display.

### 1.1 Connection lifecycle

1. **Open.** Client opens WSS; no app-level handshake beyond the WS
   handshake itself.
2. **Subscribe.** Client's first frame is a `subscribe` (see §3.2).
   Authenticated clients include a SIWE-derived JWT in `auth`;
   unauthenticated clients omit it. The server binds the wallet to the
   connection from the JWT and ignores any client-supplied wallet on
   later frames.
3. **Ack.** Server replies with an `ack` listing accepted topics and,
   if any, rejected topics with reasons.
4. **Initial state.** For each accepted topic the server emits the
   appropriate priming frame (see §4):
   - `agent` → `history` frame (replays past `WireMessage`s since
     `since.agent`, with a `cursor` for next time).
   - `vault` → `snapshot` frame (full `VaultSnapshot`).
   - `user` → `snapshot` frame (full `UserSnapshot`).
5. **Live.** Server pushes `event` (agent), `tick` (vault),
   `snapshot` (user — re-emitted on user-state change) frames as
   things happen.
6. **Keepalive.** Server emits `{ type: "ping" }` every ~30s. Client
   need not reply at the app layer — WS-level ping/pong handles
   liveness.
7. **Reconnect.** On disconnect the client re-opens, then sends a new
   `subscribe`. Cursors are per-topic:
   - `since.agent` — last seen `WireMessage.id`. Server replays missed
     events via `history`.
   - `vault` and `user` are stateless from the client's perspective —
     server simply re-emits a full snapshot. No cursor.
8. **Close codes.** Server may close with:
   - `1000` — normal close.
   - `4001` — `auth_invalid` (JWT rejected). Client should not auto-retry
     until it re-runs SIWE.
   - `4003` — `forbidden` (subscribed to a topic the principal can't see).
   - `4400` — `bad_frame` (parse error / unknown frame).

   Clients reconnect on all other close codes with exponential backoff
   capped at ~10s (existing behavior at [agent-stream.ts:111](frontend/lib/agent-stream.ts#L111)).

### 1.2 Authentication

SIWE → session JWT is established out of band over HTTPS (not part of
this contract beyond the JWT format the WSS layer validates). The JWT:

- Is presented exactly once per WSS connection, in the first
  `subscribe` frame's `auth` field.
- Binds the wallet to the connection. The wallet is **not** included
  in `WireMessage.kind === "user"` frames (existing rule at
  [agent-stream.ts:28](frontend/lib/agent-stream.ts#L28)).
- An invalid or expired JWT yields a close with `4001`.
- Connections without `auth` are unauthenticated and may subscribe
  only to `agent` (signal/action only) and `vault`.

---

## 2. Topics & visibility

| Topic   | Public can subscribe? | Authenticated extra access |
|---------|-----------------------|----------------------------|
| `agent` | Yes — sees `signal` + `action` `WireMessage`s only. | Also sees own `user` + `reply` messages. Server filters per-recipient on a single multiplexed feed. |
| `vault` | Yes — full `VaultSnapshot` + ticks. | (no extra) |
| `user`  | No — closed with `4003` if requested unauthenticated. | Sees own `UserSnapshot` (initial + on-change re-emits). |

`agent` is the same feed as today; the server's per-recipient filter
is an extension of the existing wire — clients see exactly the
`WireMessage`s they're entitled to. Wallets are never carried on
`user`/`reply` frames; clients infer "this is mine" by virtue of being
on a JWT-authenticated connection.

---

## 3. Frame types

These extend the unions at [agent-stream.ts:33-48](frontend/lib/agent-stream.ts#L33-L48).
The pre-existing `WireMessage`, `WireChip`, `WireSource`,
`ActionCategory`, `TokenSymbol`, and `clientId()` are reused as-is.

### 3.1 Server → client

```ts
import type {
  WireMessage,
  TokenSymbol,
} from "./lib/agent-stream";

export type Topic = "agent" | "vault" | "user";

export type ErrorCode =
  | "auth_required"
  | "auth_invalid"
  | "forbidden"
  | "unknown_topic"
  | "bad_frame"
  | "internal";

export type StreamFrame =
  // Lifecycle
  | { v: 1; type: "ack";      subscribed: Topic[]; rejected?: Array<{ topic: string; reason: ErrorCode }> }
  | { v: 1; type: "ping" }
  | { v: 1; type: "error";    code: ErrorCode; message: string }
  // Agent topic — existing semantics
  | { v: 1; type: "history";  topic: "agent"; events: WireMessage[]; cursor?: string }
  | { v: 1; type: "event";    topic: "agent"; event: WireMessage }
  // Vault topic — public global state
  | { v: 1; type: "snapshot"; topic: "vault"; snapshot: VaultSnapshot }
  | { v: 1; type: "tick";     topic: "vault"; tick: VaultTick }
  // User topic — private per-wallet state
  | { v: 1; type: "snapshot"; topic: "user";  snapshot: UserSnapshot };
```

Notes:
- The pre-existing `{ v: 1; type: "history" }` and `{ v: 1; type: "event" }`
  frames at [agent-stream.ts:39-41](frontend/lib/agent-stream.ts#L39-L41) gain a
  required `topic: "agent"` field. Existing client logic that ignores
  unknown fields is unaffected; a follow-up edit adds the discriminator
  to the consumer at [agent-stream.ts:97-105](frontend/lib/agent-stream.ts#L97-L105).
- `error` is non-fatal (e.g. unknown topic in subscribe). Fatal auth
  failures use a WS close code, not an error frame.

### 3.2 Client → server

```ts
export type ClientFrame =
  | {
      v: 1;
      type: "subscribe";
      topics?: Topic[];                   // default ["agent"] for back-compat with existing client
      since?: { agent?: string };         // per-topic cursor; vault/user have none
      auth?: string;                      // SIWE-derived JWT
    }
  | {
      v: 1;
      type: "user_message";               // unchanged from agent-stream.ts:48
      text: string;
      clientId: string;                   // idempotency key; server echoes as WireMessage.id
    }
  | {
      v: 1;
      type: "unsubscribe";                // optional; trivially additive
      topics: Topic[];
    };
```

Subscribe is **additive**. A client may send multiple `subscribe`
frames over a connection's lifetime to widen scope (e.g. after SIWE
completes mid-session). Each accepted topic gets its own priming
frame.

`user_message` requires the connection to be authenticated **and**
subscribed to `agent`. Server persists with `id === clientId` so the
optimistic UI row reconciles by id (existing rule at
[agent-stream.ts:23-25](frontend/lib/agent-stream.ts#L23-L25)).

---

## 4. Payload shapes

### 4.1 Vault — `VaultSnapshot`, `VaultTick`

```ts
export type VaultSnapshot = {
  // Identity
  address: string;     // 0x-prefixed 42-char checksum address (Base mainnet vault contract)
  chainId: 8453;       // Base mainnet (literal — vault is singleton on Base)

  // Headline (live, intraday)
  sharePrice: number;        // e.g. 1.0427 — vault TVL ÷ shares outstanding, live
  tvl: number;               // millions USD, live; e.g. 3.26
  basketApr: number;         // percent, live aggregate APR across positions
  basketEarned30d: number;   // USD, rolling-30d realised fee revenue
  users: number;             // count of distinct wallets currently holding > 0 ALP shares

  // 30-day series (end-of-day closes; arrays length 30, oldest → newest)
  sharePrice30d: number[];   // share-price daily closes
  tvl30d: number[];          // TVL daily closes (millions USD)
  apr30d: number[];          // basket APR daily closes (percent)

  // Composition
  allocations: VaultAllocation[]; // by token, sums to 100
  pools: VaultPool[];             // per LP position; idle reserve is a synthetic single-token pool

  // Metadata
  ts: string;          // ISO-8601 of when this snapshot was assembled
};

export type VaultAllocation = {
  token: TokenSymbol;
  pct: number;         // 0–100 (server is responsible for normalisation)
};

export type VaultPool = {
  slug: string;        // canonical, server-issued — e.g. "eth-usdc-005", "idle-reserve"
  label: string;       // display label — e.g. "ETH/USDC", "Idle reserve"
  pct: number;         // 0–100; share of the basket allocated to this position
  position:
    | { kind: "pair";   left: TokenSymbol; right: TokenSymbol }
    | { kind: "single"; token: TokenSymbol };
  apr: number;         // percent, live
  earned30d: number;   // USD, rolling-30d
};

// Partial — server sends only the fields that changed since the last
// snapshot/tick. Headline scalars (sharePrice, tvl, basketApr,
// basketEarned30d, users) update intraday; series arrays update once
// per day at the rollover boundary; allocations/pools update on
// rebalance. Frontend merges by field.
export type VaultTick = {
  ts: string;          // ISO-8601 of this tick
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
```

Cadence rules:

- `vault.snapshot` is sent exactly once per accepted `vault` subscription
  (priming) and again on reconnect.
- `vault.tick` carries any subset of fields. Live changes (price, TVL,
  APR, earned, user count) emit as they happen. EOD rollover emits a
  tick that carries all three updated 30d arrays.

### 4.2 User — `UserSnapshot`

```ts
export type UserSnapshot = {
  wallet: string;            // 0x-prefixed checksum address — echoed for clarity; server-bound
  position: UserPosition | null;     // null if wallet has never deposited
  activity: UserActivityRow[];       // most-recent first; bounded to a reasonable window (e.g. 100)
  ts: string;                        // ISO-8601 of when this snapshot was assembled
};

export type UserPosition = {
  shares: string;              // ALP shares held — integer wei as decimal string (precision-preserving)
  valueUsd: number;            // current USD value of `shares`, server-priced
  costBasisSharePrice: number; // weighted-average entry share price across all deposits
  totalDepositedUsd: number;   // gross USDC deposited over the position's lifetime
  firstDepositTs: string;      // ISO-8601 of the first deposit; drives "days held"
  pnlUsd: number;              // server-computed; net of withdrawn basis (FIFO)
  pnlPct: number;              // pnlUsd as percent of consumed-basis cost
  realizedApyPct: number;      // annualised realised return since firstDepositTs, percent
};

export type UserActivityRow = {
  id: string;                // server-issued ULID
  kind: "deposit" | "withdraw";
  amount: number;            // USDC integer
  token: TokenSymbol;        // "USDC" for v1; widened for forward compat
  ts: string;                // ISO-8601 of tx settlement
  tx: string;                // 0x-prefixed 66-char hash
};
```

Accounting policy (server-authoritative):

- **Cost basis** is the weighted-average entry share price across all
  deposits — `costBasisSharePrice`.
- **Withdrawals** consume basis lots FIFO (oldest deposit first), so
  `totalDepositedUsd` and `pnlUsd` reflect basis remaining after FIFO
  consumption.
- **Backend is authoritative.** The frontend renders `UserPosition`
  fields verbatim and never recomputes basis, value, PnL, or APY.

Cadence rules:

- `user.snapshot` is sent on subscribe (priming) and re-emitted in
  full any time the wallet's position changes — settled deposit /
  withdraw tx for this wallet, backend re-pricing as the live share
  price moves, or the connected wallet is otherwise mutated.
- The deposit-input USDC wallet balance is read on-chain via
  wagmi/viem and is **not** carried in the snapshot. ALP shares are
  carried as `position.shares`.
- The only client-derived user-scoped value is `USER_DAYS_HELD`
  (= `now − position.firstDepositTs`).

### 4.3 Agent — `WireMessage`

Reused unchanged from [agent-stream.ts:33-37](frontend/lib/agent-stream.ts#L33-L37).
The only change is the addition of the `topic: "agent"` discriminator
on the carrier `history` / `event` frames in §3.1.

```ts
// (existing)
export type WireMessage =
  | { id: string; ts: string; kind: "signal";  text: string }
  | { id: string; ts: string; kind: "action";  title: string; category: ActionCategory; chip: WireChip; tx: string; text: string; thought?: string }
  | { id: string; ts: string; kind: "user";    text: string }
  | { id: string; ts: string; kind: "reply";   text: string; replyTo?: string; sources?: WireSource[] };
```

Routing:
- `kind: "signal"` and `kind: "action"` are vault-global; every
  subscriber to `agent` receives them.
- `kind: "user"` and `kind: "reply"` are private to the connection's
  authenticated wallet; the server filters them per-recipient.

---

## 5. Inventory cadence mapping

Every entry from [DATA_INVENTORY.md](DATA_INVENTORY.md) §1, §2, §3 is
mapped to a contract field (or explicitly marked out-of-contract).

### 5.1 §1 User-scoped

| Inventory # | Field                       | Contract source                                                  | Notes |
|---|---|---|---|
| 1 | First deposit timestamp      | `user.snapshot.position.firstDepositTs`                         | first deposit; one-shot on subscribe, re-emit on tx |
| 2 | Total deposited (USDC)       | `user.snapshot.position.totalDepositedUsd`                      | gross USDC deposited over lifetime |
| 3 | First-deposit tx hash        | `user.snapshot.activity[]` (first `kind: "deposit"` row)        | full 66-char hash sourced from activity stream; FE shortens for display |
| 4 | Cost-basis share price       | `user.snapshot.position.costBasisSharePrice`                    | weighted-average across all deposits (server-side) |
| 5 | Days held                    | derived FE                                                       | `today − position.firstDepositTs` in days |
| 6 | Shares held                  | `user.snapshot.position.shares`                                 | precision-preserving decimal string; server-pushed |
| 7 | Position value (USD)         | `user.snapshot.position.valueUsd`                               | server-authoritative |
| 8 | PnL (USD / pct)              | `user.snapshot.position.pnlUsd` / `position.pnlPct`             | server-authoritative; FIFO basis consumption |
| 9 | Realized APY                 | `user.snapshot.position.realizedApyPct`                         | server-authoritative |
| 10 | Activity log                | `user.snapshot.activity[]`                                      | append on tx via fresh snapshot |
| 11 | Deposit input USDC balance  | **chain read (wagmi)**                                          | not in contract |
| 12 | Agent unread count (initial)| derived FE                                                       | local state seeded from agent push stream |
| 13 | Wallet connection state     | **wagmi**                                                        | not in contract |

### 5.2 §2 Vault-scoped

| Inventory # | Field                       | Contract source                                                  | Notes |
|---|---|---|---|
| 1  | Share price (live)           | `vault.snapshot.sharePrice` / `vault.tick.sharePrice`           | live; updates intraday |
| 2  | Share-price 30d series       | `vault.snapshot.sharePrice30d` / `vault.tick.sharePrice30d`     | EOD closes; updates at rollover |
| 3  | TVL 30d series               | `vault.snapshot.tvl30d` / `vault.tick.tvl30d`                   | EOD closes; live TVL = `vault.snapshot.tvl` (separate field) |
| 4  | Basket APR 30d series        | `vault.snapshot.apr30d` / `vault.tick.apr30d`                   | EOD closes |
| 5  | Basket APR (live, headline)  | `vault.snapshot.basketApr` / `vault.tick.basketApr`             | live; intentionally distinct from `apr30d[last]` |
| 6  | Basket earned (rolling 30d)  | `vault.snapshot.basketEarned30d` / `vault.tick.basketEarned30d` | rolling-30d window |
| 7  | Token allocations            | `vault.snapshot.allocations`                                    | token-level; sums to 100 |
| 8  | Per-pool composition         | `vault.snapshot.pools`                                          | per-pool; idle reserve included as `position.kind === "single"` |
| 9  | Per-pool APR                 | `vault.snapshot.pools[].apr`                                    | folded into `pools` |
| 10 | Per-pool earned 30d          | `vault.snapshot.pools[].earned30d`                              | folded into `pools` |
| 11 | Distinct user count          | `vault.snapshot.users` / `vault.tick.users`                     | distinct wallets currently holding > 0 ALP shares |
| 12 | Vault address (footer)       | `vault.snapshot.address`                                        | drives basescan link |

### 5.3 §3 Agent stream

| Inventory # | Field                       | Contract source                                                  | Notes |
|---|---|---|---|
| 1 | `WireMessage`                | `agent.history` (initial) + `agent.event` (live)                | unchanged from existing wire |
| 2 | Agent message seed (dev stub)| n/a                                                              | dev-stub only; not in contract |
| 3 | Quick-reply stub bot         | n/a                                                              | dev-stub only; not in contract |
| 4 | Stream URL / dev-stub gate   | env (`NEXT_PUBLIC_SHERPA_WSS_URL`)                              | not in contract |
| 5 | `clientId()`                 | client utility — `user_message.clientId`                        | unchanged |
| 6 | Default action title (FE seed)| n/a (FE seeding default)                                        | live value comes from `WireMessage.action.title` |
| 7 | `CATEGORY_LABEL`             | n/a (FE label map)                                               | maps `ActionCategory` to display string |
| 8 | Agent unread badge derivation| derived FE from agent push stream                                | not in contract |

§4 (static reference assets) and §5 (hardcoded URLs / landing copy)
are out of contract by construction. Per the constraints frozen
ahead of this doc, the landing-page allocation numbers
(`ORBIT_TOKENS`, `PORTFOLIO_PIES`, `landing-face.tsx`) remain marketing
copy and are not driven by `vault.snapshot.allocations`.

---

## 6. Client commands recap

Today only one client command exists: `user_message`. Every value the
frontend currently mocks reduces to either:

- a server push (`subscribe` + receive snapshot/tick/event), or
- a chain read (wallet balances, share balance), or
- a derived value computed from those two.

No write-tx-quoting (`previewDeposit` / `previewWithdraw`) frames are
included in v1: the deposit input's "you'll get X shares" preview is
`amount / vault.snapshot.sharePrice`, and withdraw's "you'll receive
X USDC" is `shares × vault.snapshot.sharePrice` — both derivable
without a round-trip. If the vault contract develops fee-on-deposit
or fee-on-withdraw mechanics, a `quote` request/response pair
(`{ type: "quote_deposit"; amount; clientId }` →
`{ type: "quote"; clientId; sharesOut; feeBps }`) is the expected
extension.

---

## 7. Versioning

Frame `v: 1` is mandatory; clients drop frames with other `v` values
(existing rule at [agent-stream.ts:96](frontend/lib/agent-stream.ts#L96)). Any
breaking change bumps to `v: 2`; additive fields (new optional keys
in snapshots/ticks, new `WireMessage` kinds) stay on `v: 1`.
