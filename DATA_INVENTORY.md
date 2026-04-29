# ALP Frontend — Data Inventory

A read-only catalogue of every placeholder / mock / hardcoded value the
UI consumes today. Source of truth for the backend team. **No endpoint
shapes, transports, or schemas are proposed here** — that's a separate
phase. Cadence labels below describe how the *current UI consumes* the
value, not how the backend should serve it.

Cadence vocabulary used below:
- **one-shot** — read once when the surface mounts; no auto-refresh in the UI.
- **push** — arrives via the agent WSS stream as it happens.
- **on-tx** — UI expects this to refresh after a known user/agent transaction.
- **derived** — computed in the client from another listed value (no backend call needed).
- **static** — asset metadata / labels; never changes between deploys.
- **env** — sourced from a build-time env var, not the backend.
- **chain** — read directly from chain via wagmi/viem; the backend doesn't proxy it.

Scope:
- **Primary**: `app/app/page.tsx`, `lib/agent-stream.ts`, `lib/wagmi.ts`, `components/web3-provider.tsx`.
- **Secondary** (mostly static prose + animations): `components/landing-face.tsx`, `scenery.tsx`, `shell.tsx`, `persistent-backdrop.tsx`.

---

## 1. User-scoped (requires connected wallet)

These all key off the connected address. The UI consumes them through
the `useUserPosition()` / `useUserActivity()` hooks in
[lib/api/hooks.ts](frontend/lib/api/hooks.ts); shapes are defined in
[lib/api/types.ts](frontend/lib/api/types.ts) (`UserSnapshot`,
`UserPosition`, `UserActivityRow`); the dev-stub mock lives in
[lib/api/stub.ts](frontend/lib/api/stub.ts) (`buildUserSnapshot`).

| # | Field | Source | Shape / example | Cadence | Notes |
|---|---|---|---|---|---|
| 1 | First deposit timestamp | `useUserPosition().firstDepositTs` ([lib/api/hooks.ts:89](frontend/lib/api/hooks.ts#L89)); type `UserPosition` ([lib/api/types.ts:92](frontend/lib/api/types.ts#L92)); stub seed [lib/api/stub.ts:41](frontend/lib/api/stub.ts#L41) | ISO-8601 local string `"2026-02-27T10:14:00"` | push (re-emitted snapshot on tx) | Drives the Performance card's date axis. |
| 2 | Total deposited (USDC) | `useUserPosition().totalDepositedUsd` | `5000` (USDC, integer) | push | Stable-token deposit, so HODL == principal. |
| 3 | First-deposit tx hash | `useUserActivity()[0].tx` ([lib/api/hooks.ts:94](frontend/lib/api/hooks.ts#L94)); first `kind: "deposit"` row of `UserSnapshot.activity` | full 66-char hash, e.g. `"0x82a30000…00004d91"` | push | Used to build a basescan link in the activity row. Backend sends full 0x-prefixed 66-char hashes (CONTRACT.md §1); a `shortenTxHash` formatter is owed. |
| 4 | Cost-basis share price | `useUserPosition().costBasisSharePrice` | `1.0184` | push | Weighted-average entry price across all deposits (server-authoritative). Used to compute realized APY. |
| 5 | Days held | derived FE | `60` | derived | Today − `position.firstDepositTs`, in days. The only client-derived user-scoped value. |
| 6 | Shares held | `useUserPosition().shares` | precision-preserving decimal string (wei-scaled) | push | Server-pushed as a decimal string to avoid float loss. |
| 7 | Position value (USD) | `useUserPosition().valueUsd` | `≈ 5119.21` | push | Server-priced; re-emits when the live share price moves. |
| 8 | PnL (USD / pct) | `useUserPosition().pnlUsd` / `.pnlPct` | `≈ +119.21` / `+2.38%` | push | Server-authoritative; FIFO basis consumption. Position card's "Yield" row colour-codes on sign. |
| 9 | Realized APY | `useUserPosition().realizedApyPct` | `≈ 14.69%` | push | Server-authoritative annualised return since `firstDepositTs`. The Performance card title value. |
| 10 | Activity log | `useUserActivity()` ([lib/api/hooks.ts:94](frontend/lib/api/hooks.ts#L94)); type `UserActivityRow[]` ([lib/api/types.ts:103](frontend/lib/api/types.ts#L103)) | `Array<{ id; kind: "deposit" \| "withdraw"; amount; token; ts; tx }>` | push (on-tx) | Per-wallet deposit/withdraw log. Bounded to a reasonable window per CONTRACT.md §4.2; most-recent first. |
| 11 | Deposit input balance | wagmi `useBalance` against Base mainnet USDC | e.g. `"Balance: 1234.56"` | chain | **Not** a backend value: the USDC contract address is a frontend config constant (Base mainnet USDC is well-known), and the backend doesn't publish or proxy it. |
| 12 | Wallet connection state | wagmi `useAccount()` (FloatingNav, VaultCard); AppKit modal via `useAppKit()` | n/a | chain | Wired via `Web3Provider` (see §5). FloatingNav shows truncated address `0x1234…abcd` when connected and falls back to "Connect wallet" otherwise. VaultCard CTA flips between "Connect wallet" and "Deposit". Required to gate every entry in this section. |

> The agent-unread badge count was previously listed here. It's a chat-stream
> derivation (FE-local state in `AgentChatPanel`), so its canonical home
> is §3 row 8.

---

## 2. Vault-scoped (global, single vault)

The vault is singleton. None of these need a connected wallet. The UI
consumes them through `useVault()` / `useVaultSnapshot()` in
[lib/api/hooks.ts](frontend/lib/api/hooks.ts); shapes are defined in
[lib/api/types.ts](frontend/lib/api/types.ts) (`VaultSnapshot`,
`VaultTick`, `VaultAllocation`, `VaultPool`); the dev-stub mock lives
in [lib/api/stub.ts](frontend/lib/api/stub.ts) (`buildVaultSnapshot`).

| # | Field | Source | Shape / example | Cadence | Notes |
|---|---|---|---|---|---|
| 1 | Share price (live) | `useVaultSnapshot().sharePrice` ([lib/api/hooks.ts:74](frontend/lib/api/hooks.ts#L74)); type `VaultSnapshot.sharePrice` ([lib/api/types.ts:56](frontend/lib/api/types.ts#L56)); stub seed [lib/api/stub.ts:21](frontend/lib/api/stub.ts#L21) | `1.0427` | push (intraday tick) | Headline number; appears on Vault card, Withdraw modal, Stats sidebar. Derived server-side from vault TVL ÷ shares outstanding. |
| 2 | Share-price 30d series | `useVaultSnapshot().sharePrice30d`; stub seed [lib/api/stub.ts:23-27](frontend/lib/api/stub.ts#L23-L27) | `number[30]` daily closes (oldest → newest) | push (EOD rollover) | Drives the Stats sidebar's Share-price mini sparkline. |
| 3 | TVL 30d series | `useVaultSnapshot().tvl30d`; stub seed [lib/api/stub.ts:28-32](frontend/lib/api/stub.ts#L28-L32) | `number[30]` (millions USD; e.g. `3.26`) | push (EOD rollover) | Live TVL is the separate `useVaultSnapshot().tvl` field, not the series tail (CONTRACT.md §4.1). Drives the Stats sidebar TVL block + sparkline. |
| 4 | Basket APR 30d series | `useVaultSnapshot().apr30d`; stub seed [lib/api/stub.ts:33-37](frontend/lib/api/stub.ts#L33-L37) | `number[30]` percent | push (EOD rollover) | Drives the Performance card's hover-trackable sparkline AND the Stats sidebar mini sparkline. |
| 5 | Basket APR (live, headline) | `useVaultSnapshot().basketApr`; stub seed [lib/api/stub.ts:38](frontend/lib/api/stub.ts#L38) | `14.2` | push (intraday tick) | Headline "Deposit APY" / "Current yield" number. Intentionally distinct from `apr30d[last]` per CONTRACT.md §4.1. |
| 6 | Basket earned (rolling 30d) | `useVaultSnapshot().basketEarned30d` | `≈ 2666.60` USD | push (rolling 30d) | "fees earned" pill in Stats hero. Server-served directly (stub computes as sum of per-pool earned). |
| 7 | Token allocations | `useVaultSnapshot().allocations`; type `VaultAllocation[]` ([lib/api/types.ts:38](frontend/lib/api/types.ts#L38)); stub seed [lib/api/stub.ts:80-86](frontend/lib/api/stub.ts#L80-L86) | `Array<{ token: TokenSymbol; pct: number }>` — 5 rows: USDC 38, ETH 24, BTC 18, USDT 12, UNI 8 | push | The "Exposure" gauges in the Stats sidebar are by *token*. `pct` is a token-level allocation (USDC includes the idle reserve); sums to 100. |
| 8 | Per-pool composition | `useVaultSnapshot().pools`; type `VaultPool[]` ([lib/api/types.ts:47](frontend/lib/api/types.ts#L47)); stub seed [lib/api/stub.ts:87-93](frontend/lib/api/stub.ts#L87-L93) | 5 entries: `{ slug; label; pct; position: pair \| single; apr; earned30d }` — 4 pools + idle reserve | push | Per-position allocation. `Idle reserve` is a synthetic single-token pool (`position.kind === "single"`, token `USDC`). |
| 9 | Per-pool APR | `useVaultSnapshot().pools[].apr` | `number` per entry — 5 entries | push | Folded into `pools` (CONTRACT.md §4.1). Per-pool APR shown in the Exposure table. |
| 10 | Per-pool earned 30d | `useVaultSnapshot().pools[].earned30d` | `number` per entry — 5 entries (USD) | push | Folded into `pools`. Per-pool 30d fees earned in USD. |
| 11 | Distinct user count | `useVaultSnapshot().users`; stub seed [lib/api/stub.ts:39](frontend/lib/api/stub.ts#L39) | `247` (integer) | push (intraday tick) | "users" stat in the Stats sidebar hero. Defined as distinct wallets currently holding > 0 ALP shares (CONTRACT.md §4.1). |
| 12 | Vault address (footer) | `useVaultSnapshot().address`; stub seed [lib/api/stub.ts:56](frontend/lib/api/stub.ts#L56) | `"0xA1b2C3d4…f9C8"` (full 42-char checksum address) | push (static within deploy) | Drives the basescan address URL on the footer Vault chip. |

### Phase-4-prep cleanup — inline literals not bound to constants

The following display strings used to be typed in JSX literally instead
of reading from the vault hook. Phase 5 rewired them; cross-check
remains useful as a regression tripwire.

| Surface | Literal | Where | Should bind to |
|---|---|---|---|
| VaultCard sub-card 2 | `$1.0427` | [page.tsx:1095](frontend/app/app/page.tsx#L1095) | `useVaultSnapshot().sharePrice` |
| VaultCard sub-card 2 | `$3.26M`  | [page.tsx:1113](frontend/app/app/page.tsx#L1113) | `useVaultSnapshot().tvl` (live TVL field, not the series tail) |
| VaultCard sub-card 2 | `Instant up to reserve` (copy) | [page.tsx:1104](frontend/app/app/page.tsx#L1104) | static copy, but currently duplicated — fold into a shared constant |
| WithdrawModal | `$1.0427` | [page.tsx:1553](frontend/app/app/page.tsx#L1553) | `useVaultSnapshot().sharePrice` |
| WithdrawModal | `$3.26M`  | [page.tsx:1571](frontend/app/app/page.tsx#L1571) | `useVaultSnapshot().tvl` |
| WithdrawModal | `Instant up to reserve` (copy) | [page.tsx:1562](frontend/app/app/page.tsx#L1562) | same as VaultCard's |

---

## 3. Agent stream (Sherpa)

Wire format is defined in [lib/agent-stream.ts:33-37](frontend/lib/agent-stream.ts#L33-L37) and re-exported via [lib/api/types.ts](frontend/lib/api/types.ts). The
UI consumes via the `useAgentStream()` / `useSendUserMessage()` hooks
in [lib/api/hooks.ts](frontend/lib/api/hooks.ts); the client picks
between the real WSS client ([lib/api/client.ts](frontend/lib/api/client.ts)) and the dev stub
([lib/api/stub.ts](frontend/lib/api/stub.ts)) at module load based on
`NEXT_PUBLIC_SHERPA_WSS_URL` (see [lib/api/hooks.ts:32-41](frontend/lib/api/hooks.ts#L32-L41)).
The wire-protocol comment at
[lib/agent-stream.ts:3-4](frontend/lib/agent-stream.ts#L3-L4) is authoritative: tx
hashes go on the wire raw (no explorer URLs), full 0x-prefixed length —
view layer adapts.

| # | Field | Source | Shape / example | Cadence | Notes |
|---|---|---|---|---|---|
| 1 | `WireMessage` (signal/action/user/reply) — live + history | `useAgentStream().messages` ([lib/api/hooks.ts:101](frontend/lib/api/hooks.ts#L101)); type re-exported via [lib/api/types.ts](frontend/lib/api/types.ts) | discriminated union: `{ id; ts; kind; … }`; tx hashes raw, NO explorer URLs | push | `signal` and `action` are vault-scoped (the agent's public actions); `user` and `reply` are per-wallet (server binds wallet to the connection from the JWT). Single multiplexed feed; server filters per-recipient (CONTRACT.md §2). |
| 2 | Dev-stub priming history | [lib/api/stub.ts:129-152](frontend/lib/api/stub.ts#L129-L152) (`seedAgentMessages`) | 13 entries (8 signals/actions + thoughts) covering 2026-04-28 05:18 → 14:23 | static | Emitted as the agent topic's `history` priming frame by `createStubClient()`. Lives entirely under `lib/api/stub.ts`; not in the contract. Tx hashes are full 66-char placeholders. |
| 3 | Dev-stub quick-reply bot | [lib/api/stub.ts](frontend/lib/api/stub.ts) (inside `createStubClient`'s `sendUserMessage`) | regex → `{ text; sources? }` rules + a default fallback | static | Synthesises agent replies locally inside the stub client. Used only in the no-WSS-URL branch; not in the contract. |
| 4 | Stream URL / dev-stub gate | [lib/api/hooks.ts:32-41](frontend/lib/api/hooks.ts#L32-L41) | `process.env.NEXT_PUBLIC_SHERPA_WSS_URL`; falsy → `createStubClient()` | env | When unset: hooks resolve from `lib/api/stub.ts` — same hook surface, mock data. When set: `lib/api/client.ts` opens a real WSS and the same hooks subscribe to it. UI does not branch on dev-vs-real. |
| 5 | `clientId()` | [lib/agent-stream.ts:123-125](frontend/lib/agent-stream.ts#L123-L125) | `c_<base36-ts>_<base36-rand>` | derived | Idempotency key on outgoing user messages so the optimistic UI row reconciles with the server echo. Reused by both the real client and the stub. |
| 6 | Default action title (FE seed) | inline in [lib/api/stub.ts:131](frontend/lib/api/stub.ts#L131) and adjacent stub action rows | `"Action submitted"` | static | Stub-only seeding default. Live `WireMessage` of `kind: "action"` carries `title` from the server. |
| 7 | `CATEGORY_LABEL` | [page.tsx](frontend/app/app/page.tsx) (FE-local label map) | `Record<ActionCategory, string>` — `swap` / `edit_position` / `claim_fees` | static | UI label map for the Stats-tab Recent-actions log. |
| 8 | Agent unread badge derivation | local state in `AgentChatPanel` (FE-only) | local state, seeded `3` | derived | Bump on incoming `WireMessage`, but always after we know the user isn't already on the Agent tab. Real value is local-state derived from the push stream; the `3` is just visual seed. |

---

## 4. Static reference (asset metadata, labels, icons)

Never changes between deploys. No backend involvement expected.

| # | Field | Source | Notes |
|---|---|---|---|
| 1 | `TOKENS` | [page.tsx:119-125](frontend/app/app/page.tsx#L119-L125); duplicated in [landing-face.tsx:2284-2290](frontend/components/landing-face.tsx#L2284-L2290) | 5-token registry: `{ slug; kind: "svg"\|"png"; src; color }`. Resolves WireMessage symbol strings. `resolveToken()` falls back to USDC for unknown symbols. |
| 2 | `MASK_STYLE` | [page.tsx:106-116](frontend/app/app/page.tsx#L106-L116), [landing-face.tsx:18-28](frontend/components/landing-face.tsx#L18-L28) | CSS for the alps-logo PNG mask. Path `/logo.png` is part of the design surface. |
| 3 | `ICONS` / `FILLED_ICONS` | [page.tsx:127-130](frontend/app/app/page.tsx#L127-L130), [page.tsx:207-259](frontend/app/app/page.tsx#L207-L259) | Inline SVG path strings keyed by name. |
| 4 | `LANDSCAPE_FILTER`, `LANDSCAPE_FILTER_MUTED` | [page.tsx:63, 68](frontend/app/app/page.tsx#L63) | Shared CSS filter strings; not data. |
| 5 | `EXPOSURE_GRID` | [page.tsx:2302](frontend/app/app/page.tsx#L2302) | Shared CSS grid template. |
| 6 | `SourceKind` icon set + adapter | [page.tsx:171-194](frontend/app/app/page.tsx#L171-L194), [page.tsx:596-626](frontend/app/app/page.tsx#L596-L626) | `vault` / `uniswap` / `basescan` with a fixed renderer. |
| 7 | Landscape image | `/landscape.png` (referenced at [page.tsx:711](frontend/app/app/page.tsx#L711), [page.tsx:742](frontend/app/app/page.tsx#L742), [scenery.tsx:23](frontend/components/scenery.tsx#L23), [scenery.tsx:51](frontend/components/scenery.tsx#L51), [persistent-backdrop.tsx:36](frontend/components/persistent-backdrop.tsx#L36)) | Static asset, not data. |
| 8 | Noise texture overlay | `/noise.png` referenced at [layout.tsx:55](frontend/app/layout.tsx#L55) | Full-viewport overlay at 1.2% opacity. Static asset. |

---

## 5. Hardcoded URLs / external resources

| # | Value | Where | Purpose |
|---|---|---|---|
| 1 | `https://basescan.org/tx/` | [page.tsx:1718](frontend/app/app/page.tsx#L1718) (`TX_BASE_URL`) | Prefix for every action / activity / source link that has a tx hash. Hash is interpolated with U+2026 stripped (via the seed's pre-shortened form); a real `shortenTxHash` formatter is owed once the live feed sends full hashes. |
| 2 | `https://app.uniswap.org/` | inside the dev-stub quick-reply bot in [lib/api/stub.ts](frontend/lib/api/stub.ts) | Pool-page links. **Not pool-specific** today — every `uniswap` source points at the app root. |
| 3 | `process.env.NEXT_PUBLIC_SHERPA_WSS_URL` | [lib/api/hooks.ts:32](frontend/lib/api/hooks.ts#L32) | Agent stream WSS endpoint. Falsy → dev-stub client. |
| 4 | `process.env.NEXT_PUBLIC_REOWN_PROJECT_ID` | [lib/wagmi.ts:6](frontend/lib/wagmi.ts#L6) | Reown / WalletConnect project ID. **Required at boot** — `lib/wagmi.ts:8-12` throws if it's missing. |
| 5 | `https://cloud.reown.com` | [lib/wagmi.ts:10](frontend/lib/wagmi.ts#L10) | Mentioned in the missing-env-var error message; not a runtime URL. |
| 6 | AppKit metadata: `name: "alps"`, `description: "An onchain basket vault."`, `url: "https://alps.finance"`, `icons: []` | [components/web3-provider.tsx:9-14](frontend/components/web3-provider.tsx#L9-L14) | Surfaced in the AppKit modal / mobile wallet handshake. The `url` is the canonical site origin and must match the deployed domain for WalletConnect verification. |
| 7 | `href="#"` on the footer Vault link | [page.tsx:3036](frontend/app/app/page.tsx#L3036) | Placeholder; should resolve to the deployed vault address on basescan. |
| 8 | `v0.0.1` version string | [page.tsx:3067](frontend/app/app/page.tsx#L3067) | Display only; static. |

### Landing page (out-of-scope for the dashboard contract but worth flagging)

The landing surface is "mostly static prose + animations" per the task
brief. Captured here so backend doesn't accidentally try to drive it.
The duplicated `38/24/18/12/8` allocation set (L1, L4, L5) is intentional —
landing stays frozen as marketing copy, not driven by the live
`vault.snapshot.allocations` field.

| # | Field | Source | Notes |
|---|---|---|---|
| L1 | `DEPOSITS` (per-token amounts: $1.20M, $850K, $620K, $245K, $145K) | [landing-face.tsx:31-37](frontend/components/landing-face.tsx#L31-L37) | Hover-tooltip in the landing's "Total deposits" pill. Hardcoded prose; landing stays frozen. |
| L2 | `BUILT_ON` (Uniswap, KeeperHub, Gensyn, X) — partner names + outbound links | [landing-face.tsx:259-311](frontend/components/landing-face.tsx#L259-L311) | Outbound URLs: `https://x.com`, `https://developers.uniswap.org/docs`, `https://keeperhub.com`, `https://gensyn.ai`. Static. |
| L3 | `USDC_VAULT_ENTRY` | [landing-face.tsx:1372-1377](frontend/components/landing-face.tsx#L1372-L1377) | Static USDC chip metadata for the deposit visualisation. |
| L4 | `ORBIT_TOKENS` (vault basket viz; pct: 38/24/18/12/8 — same numbers as the live allocation set) | [landing-face.tsx:2580-2586](frontend/components/landing-face.tsx#L2580-L2586) | Animation prop set; not driven by live data. |
| L5 | `PORTFOLIO_PIES` (same allocation set) | [landing-face.tsx:2394-2400](frontend/components/landing-face.tsx#L2394-L2400) | Same numbers as `ORBIT_TOKENS` and the live allocation set; three sources of truth, intentionally frozen. |
| L6 | `PORTFOLIO_TOKENS`, `POOL_PAIRS` | [landing-face.tsx:2291-2305](frontend/components/landing-face.tsx#L2291-L2305) | Static asset config. |
| L7 | `CONTEXT_BULLETS`, `AGENT_BULLETS`, `EXECUTION_BULLETS` (8 each) | [landing-face.tsx:534-563](frontend/components/landing-face.tsx#L534-L563) | Marketing copy for the Context → Thinking → Execution typing animation. NOT wired to the live agent. |
| L8 | `BAR_VALUES`, `POOL_RATIOS` | [landing-face.tsx:632, 641-645](frontend/components/landing-face.tsx#L632) | Animation parameters; not data. |
| L9 | `PRICE_PATH` | [landing-face.tsx:2768-2783](frontend/components/landing-face.tsx#L2768-L2783) | Static SVG path string (CoinGecko sample, detrended) for the StrategyViz scrolling chart. |
| L10 | `WORDS = "Start earning from onchain volume"` | [landing-face.tsx:9](frontend/components/landing-face.tsx#L9) | Catchphrase headline. |
| L11 | `localStorage["alp:intro-played"]` | [shell.tsx:28](frontend/components/shell.tsx#L28) | Client-only flag controlling whether the entry choreography replays. Not backend-served. Read synchronously by the inline script in [layout.tsx:42-47](frontend/app/layout.tsx#L42-L47) before React hydrates. |

---

## 6. Open questions

Things I couldn't pin down from the code/comments alone — originally
flagged for the contract phase. The first three are resolved by
[CONTRACT.md](CONTRACT.md).

1. **Definition of the "users" stat.** Resolved by
   [CONTRACT.md §4.1](CONTRACT.md#41-vault--vaultsnapshot-vaulttick):
   `vault.snapshot.users` is "count of distinct wallets currently
   holding > 0 ALP shares" — withdraw-to-zero decrements; lifetime
   uniques are not tracked.

2. **Agent stream scoping.** Resolved by
   [CONTRACT.md §2](CONTRACT.md#2-topics--visibility): a single
   multiplexed `agent` topic; the server filters `user` / `reply`
   per-recipient on the same feed. Unauthenticated visitors may
   subscribe to `agent` and see only `signal` / `action`; `user`
   subscriptions are rejected.

3. **Headline scalars vs end-of-day series.** Resolved by
   [CONTRACT.md §4.1](CONTRACT.md#41-vault--vaultsnapshot-vaulttick):
   they are intentionally distinct fields — `vault.snapshot.sharePrice`
   and `vault.snapshot.basketApr` are live intraday;
   `sharePrice30d` and `apr30d` are end-of-day closes that update at
   the rollover boundary. The server is free to make them coincide on
   a clean rollover but the contract carries them as separate fields.
