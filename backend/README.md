# ALP Backend — B7 (rate limit + ingest API + deploy)

ETHGlobal OpenAgents — backend WSS for the Alphix ALP dashboard. Implements
the wire layer + topic dispatcher (`agent` / `vault` / `user`) defined in
[../CONTRACT.md](../CONTRACT.md), plus a SIWE → JWT auth surface on the
same port. As of B7:

- Vault `sharePrice` / `tvl` / `sharePrice30d` / `tvl30d` come from
  `convertToAssets` + `totalAssets` reads (B3).
- Vault `users` / `basketApr` / `basketEarned30d` / `apr30d` come from an
  in-memory event indexer over `Transfer` / `FeesCollected` / `PoolTracked`
  logs (B3b).
- Per-wallet `UserSnapshot` (position + activity) comes from the same
  indexer, extended with ERC4626 `Deposit` / `Withdraw` event ingest and
  WAVG cost-basis + FIFO consumption accounting (B4).
- The `agent` topic now mixes scripted signals/replies with **real chain
  action events** translated from `LiquidityAdded` / `LiquidityRemoved` /
  `Swapped` / `FeesCollected` / `PositionTracked` / `PositionUntracked`
  logs (B5). Action `WireMessage`s always carry the real on-chain tx hash;
  the mock priming seed is signal-only.
- `allocations` and `pools` remain mocked (B3c).
- All of the above is **persisted to a single sqlite file** so a server
  restart resumes from where it stopped — the indexer only refetches the
  block gap, the agent ring's full window survives reboot, and recently
  issued auth nonces stay rejectable as replay (B6).
- A per-WS-connection token bucket protects the public `user_message`
  path; an authenticated **agent ingest API** publishes signals/replies
  and forwards every accepted user message to a connected agent process
  (B7). Action `WireMessage`s still come exclusively from the chain.
- A systemd unit + runbook ship under [`deploy/`](deploy/) so the same
  binary fronts a Linux VM with TLS terminated upstream by Caddy or
  nginx (B7).

Deployment target: a Linux VM (Google Cloud `e2-medium`). The instructions
below assume a fresh VM — there's no Windows / macOS dev path. For the
production runbook, see [`deploy/README.md`](deploy/README.md).

## Run on the VM

```bash
# 1. One-time bootstrap
curl -fsSL https://bun.sh/install | bash
exec $SHELL                       # or `source ~/.bashrc` to put bun on PATH
bun --version                     # sanity check

# 2. Per clone
git clone <repo-url> alp
cd alp/backend
cp .env.example .env

# REQUIRED: replace JWT_SECRET and INGEST_SECRET in .env. The server
# refuses to start without 32+ char values for both.
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^INGEST_SECRET=.*|INGEST_SECRET=$(openssl rand -base64 48)|" .env

bun install
bun run dev
```

Listens on `http://0.0.0.0:8787` (or whatever `PORT` resolves to):

| route                    | type | meaning                                                            |
|--------------------------|------|--------------------------------------------------------------------|
| `GET  /health`           | HTTP | `{ ok, mode, lastIndexedBlock, ringSize, connections, uptimeSec }` |
| `GET  /auth/nonce`       | HTTP | `{ nonce }` — 16-byte base64url; 10-minute TTL                     |
| `POST /auth/verify`      | HTTP | SIWE message + signature → `{ token, wallet, exp }`                |
| `POST /auth/dev-token`   | HTTP | dev-only; mints a JWT for any address. **404 unless `AUTH_DEV_BYPASS=1`** |
| `WS   /stream`           | WS   | multiplexed agent/vault/user topics (per `CONTRACT.md` v1)         |
| `POST /ingest/signal`    | HTTP | agent-only; publish a vault-global signal (B7). `Authorization: Bearer <INGEST_SECRET>` |
| `POST /ingest/reply`     | HTTP | agent-only; publish a private reply to a wallet (B7).              |
| `WS   /ingest/stream`    | WS   | agent-only forward stream — every accepted public `user_message` (B7). Auth: `?secret=<INGEST_SECRET>` |

`bun run dev` watches `src/**` and reloads on save. For a non-watching
foreground run use `bun run start`.

## Smoke test from another shell on the same VM

```bash
# 1. Health
curl -s http://localhost:8787/health
# expect: {"ok":true,"mode":"chain"|"mock","lastIndexedBlock":...,"ringSize":N,"connections":N,"uptimeSec":N}

# 2. Nonce
curl -s http://localhost:8787/auth/nonce
# expect: {"nonce":"<22-char base64url>"}

# 3. End-to-end: 7 flows (anon, authed, bad-token, vault-chain, persistence,
#    ingest API, rate limit). Requires AUTH_DEV_BYPASS=1 on the running
#    server. Flows 6+7 (ingest + rate) also require INGEST_SECRET to be
#    exported with the same value the server is using.
INGEST_SECRET="<same value as server>" bun run scripts/smoke.ts
# expect: PASS lines for every applicable flow
```

If any flow fails, the dev server log (`bun run dev`) prints
`[ws cid=… dir=…]` lines per inbound/outbound frame — that's the first
place to look.

## Auth (SIWE)

The frontend establishes a session over HTTPS, then presents the resulting
JWT exactly once on the WSS subscribe frame's `auth` field.

### Flow

1. **`GET /auth/nonce`** → `{ nonce }`. Server stores it with a 10-minute
   TTL and a "consumed" flag.
2. Frontend builds an EIP-4361 SIWE message using that nonce, with
   `domain` / `uri` matching `EXPECTED_DOMAIN` / `EXPECTED_URI` and
   `chainId: 8453` (Base mainnet).
3. User signs in their wallet. Frontend POSTs **`/auth/verify`** with
   `{ message, signature }`. On success → `{ token, wallet, exp }`.
   Errors:
   - `400 wrong_chain` — `chainId` is not 8453
   - `400 wrong_domain` — `domain` ≠ `EXPECTED_DOMAIN` or `uri` doesn't
     start with `EXPECTED_URI`
   - `400 bad_nonce` — nonce missing, expired, or already consumed
   - `401 bad_signature` — SIWE library could not verify the signature
4. Frontend opens WSS; first `subscribe` frame includes `auth: <token>`.
   Server validates the JWT, decodes `sub` as the wallet, binds it to
   the connection. Invalid/expired/malformed token → WS close `4001`
   (`auth_invalid`).

JWT is HS256, signed with `JWT_SECRET`, payload `{ sub: wallet, iat, exp }`.
Default TTL 24h (`JWT_TTL_SECONDS`). No refresh — re-run SIWE on expiry.

### Dev bypass (`AUTH_DEV_BYPASS=1`)

`POST /auth/dev-token { "wallet": "0x..." }` mints a JWT for any address
without a SIWE signature. Used by `scripts/smoke.ts` and to unblock FE
integration before the SIWE side lands. Returns `404` when the env flag
is unset or `0`.

> ⚠️ **Production: ensure `AUTH_DEV_BYPASS` is unset or `0`.** Anyone who
> can reach the endpoint can mint a token for any wallet otherwise.

### Storage (B6)

Nonces and the consumed-token blacklist are mirrored into the sqlite file
at `ALP_DB_PATH` (default `./data/alp.sqlite`). A server bounce no longer
makes a recently issued nonce replayable, and an in-flight verify can land
across restart. See [Persistence (B6)](#persistence-b6) below.

## Wire the frontend

Set in `alp/frontend/.env.local`:

```
NEXT_PUBLIC_SHERPA_WSS_URL=ws://<vm-ip>:8787/stream
```

For a publicly reachable URL, point `NEXT_PUBLIC_SHERPA_WSS_URL` at the
TLS-fronted host (`wss://alp.example.com/stream`). The backend itself
speaks plain HTTP/WS — TLS terminates upstream in Caddy or nginx; see
[`deploy/README.md`](deploy/README.md).

## Env vars

| var                  | default                  | meaning                                                 |
|----------------------|--------------------------|---------------------------------------------------------|
| `PORT`               | `8787`                   | HTTP/WS port the backend binds                          |
| `DEBUG_FRAMES`       | `1`                      | Log inbound/outbound frame summaries                    |
| `JWT_SECRET`         | **required (≥32 chars)** | HS256 signing key. Server exits at boot if absent/short |
| `JWT_TTL_SECONDS`    | `86400`                  | Session token lifetime                                  |
| `EXPECTED_DOMAIN`    | `localhost:3000`         | SIWE `domain` must match exactly                        |
| `EXPECTED_URI`       | `http://localhost:3000`  | SIWE `uri` must start with this                         |
| `CORS_ALLOW_ORIGIN`  | `http://localhost:3000`  | CORS allow-origin for `/auth/*` and `/health`           |
| `AUTH_DEV_BYPASS`    | `0`                      | If `1`, exposes `POST /auth/dev-token`. Dev only — must be `0` in production. |
| `INGEST_SECRET`      | **required (≥32 chars)** | Shared secret for `/ingest/*`. Server exits at boot if absent/short. Generate with `openssl rand -base64 48`. |
| `ALP_DB_PATH`        | `./data/alp.sqlite`      | sqlite store for persisted state (agent ring, indexer cursor + per-wallet state, auth nonces). Parent dir auto-created. |

## Chain reads (B3)

The vault topic reads `sharePrice` and `tvl` from the deployed ALPVault
contract every 5s via viem against Base mainnet, and samples a 30-point
daily history on startup for `sharePrice30d` and `tvl30d`. Conversions
match Solidity scaling: shares are 18 decimals, USDC is 6 decimals, so
`sharePrice = convertToAssets(1e18) / 1e6` and `tvl = totalAssets() / 1e12`
(i.e. millions of USD).

Required env for chain mode:

| var             | meaning                                                 |
|-----------------|---------------------------------------------------------|
| `BASE_RPC_URL`       | Base mainnet HTTP RPC. `https://mainnet.base.org` works for low volume; substitute Alchemy/QuickNode for production. |
| `VAULT_ADDRESS`      | Deployed ALPVault address (0x… 42 chars). `mock` or unset = fall back. |
| `VAULT_DEPLOY_BLOCK` | Optional. Block where ALPVault was deployed; backfill starts here for accurate lifetime stats. Defaults to `head - 100000` (~2.3 days). |
| `LOG_CHUNK_BLOCKS`   | Optional. `eth_getLogs` chunk size for backfill. Default `10000`; raise on dedicated RPCs. |

If either is missing or `VAULT_ADDRESS=mock`, the server logs
`[vault] mock mode: …` at boot and runs the unchanged B1 random-walk
ticker — this lets the VM run cleanly while the contract team is still
deploying.

Chain-derived fields (B3): `address`, `sharePrice`, `tvl`, `sharePrice30d`,
`tvl30d`. Chain-derived fields (B3b): `users`, `basketApr`,
`basketEarned30d`, `apr30d`. Still mocked: `allocations`, `pools` —
those need a `PoolRegistry` + adapter walk and land in B3c.

Tick emissions in chain mode are partial. The 5s poll diffs each chain
field against its prior value and only stamps changed fields onto the
tick:

| field             | epsilon          |
|-------------------|------------------|
| `sharePrice`      | `≥ 0.0001`       |
| `tvl`             | `≥ 0.001`        |
| `basketApr`       | `≥ 0.01`         |
| `basketEarned30d` | `≥ 0.01`         |
| `users`           | any change (int) |

`apr30d` is intentionally not stamped on partial ticks — clients receive
it on the next snapshot. EOD rollover lands later. Failed reads log a
warning and skip emission; the loop never crashes.

## Vault event indexer (B3b)

On chain-mode startup, before the first vault snapshot is served, the
indexer:

1. Computes a backfill window: `[VAULT_DEPLOY_BLOCK, head]` if set,
   otherwise `[head - 100_000, head]` (~2.3 days on Base).
2. Walks the window in `LOG_CHUNK_BLOCKS` increments (default 10000),
   pulling `Transfer` (the vault's own ERC20), `FeesCollected`, and
   `PoolTracked` logs in parallel per chunk.
3. Folds them into in-memory state: a `balances` map for live shareholder
   counting, a `feeEvents` ring for the 30d revenue window, and a
   `poolOrientation` map keyed by `poolKey`.

Pool orientation (which side of `(amount0, amount1)` is USDC) is
determined off-chain via Uniswap V3/V4's `token0 < token1` invariant and
the well-known USDC address — no extra RPC calls.

After backfill, the indexer hooks the same 5s poll loop as the chain
reader: each tick fetches `(lastIndexedBlock, head]` (typically tiny)
and folds in the new logs. Stale fee events are pruned hourly to keep
memory bounded.

### Limitations

- **Non-USDC fee value is not counted.** `basketEarned30d` and `basketApr`
  reflect only the USDC side of `FeesCollected`. The non-USDC side
  requires a spot price source and lands in B3c. A vault that mostly
  earns ETH/BTC fees will under-report until then.
- **No reorg handling.** Base soft-finalises at ~2 blocks; we ignore
  reorgs at this scope.
- **`apr30d` is computed against `tvl30d` snapshots.** It is the
  per-day fee USD divided by that day's TVL, annualised. EOD rollover
  is out of scope this phase.

## User position (B4)

Chain mode extends the indexer with ERC4626 `Deposit` / `Withdraw` events,
keyed by the `owner` address (the share-holding party). Per wallet:

- A FIFO queue of basis lots: `{ tsMs, assetsIn, sharesMinted, sharesRemaining,
  sharePriceAtEntry }`. `Deposit` pushes a new lot; `Withdraw` consumes
  shares from the head, dropping fully-consumed lots and shrinking the
  partially-consumed one.
- An activity buffer of `UserActivityRow[]` — newest-first, capped at 100,
  with ids of the form `txHash:logIndex` (so a hypothetical same-tx
  Deposit + Withdraw produces two distinct rows and backfill / incremental
  overlap is idempotent).
- A `firstDepositTs` anchor: set on first deposit, advanced to the new
  oldest lot's `tsMs` after each partial withdraw, cleared when the lot
  list empties (so a full exit then re-entry restarts "days held" cleanly).

`getUserSnapshot(wallet, sharePriceNow)` assembles the wire payload:

| field                 | derivation                                                                                                          |
|-----------------------|---------------------------------------------------------------------------------------------------------------------|
| `shares`              | `balances[wallet]` — set by ERC20 `Transfer` ingest (B3b); independent of the lot list                              |
| `valueUsd`            | `(shares / 1e18) * sharePriceNow`                                                                                   |
| `costBasisSharePrice` | share-weighted WAVG of `sharePriceAtEntry` across remaining lots                                                    |
| `totalDepositedUsd`   | sum of `(assetsIn / 1e6) * (sharesRemaining / sharesMinted)` across remaining lots — basis remaining after FIFO     |
| `firstDepositTs`      | ISO of `firstDepositTs[wallet]`                                                                                     |
| `pnlUsd`              | `valueUsd - totalDepositedUsd`                                                                                      |
| `pnlPct`              | `(pnlUsd / totalDepositedUsd) * 100` — denominator is current active basis                                          |
| `realizedApyPct`      | `(pnlUsd / totalDepositedUsd) * (365 / daysHeld) * 100`; 0 until at least one full day has elapsed                  |

Backend is the sole authority — the FE renders these verbatim and never
recomputes basis, value, PnL, or APY (per
[../CONTRACT.md](../CONTRACT.md) §4.2).

Re-emission cadence (CONTRACT §4.2 + FE clarification 1):

- **Tx-driven** — on every `Deposit` / `Withdraw` for the wallet, fire a
  fresh `user.snapshot` immediately. Same-block events are batched into a
  single re-emit per wallet.
- **Share-price-driven** — piggybacks on the vault's 5s poll. Per
  connection, recompute the cheap `(balance × sharePriceNow)` projection
  and emit when `|delta valueUsd| ≥ $0.01` OR when `≥ 2s` have elapsed
  since the last emission AND `valueUsd` actually changed. In steady
  state on a quiet chain this caps at roughly one re-emit every 2s per
  user-topic connection (and zero on a wallet with no shares).

Limitations (B4):

- **Peer-to-peer share transfers are not migrated.** Mints/burns are
  driven by the Deposit/Withdraw event path. A `Transfer` where neither
  party is `0x0` updates `balances` (so vault TVL/holder counts stay
  correct) but does not move basis between lot lists. A warning is logged
  per peer transfer encountered. Revisit only if it surfaces in demo.
- **Mock mode unchanged.** When `VAULT_ADDRESS` is unset or `mock`, the
  user topic serves the existing B1 demo snapshot on subscribe and never
  re-emits. No watchers, no debounce.

## Agent action feed (B5)

Per project policy (FE lead clarification 2026-04-29), every `kind: "action"`
`WireMessage` MUST carry a real on-chain tx hash — the FE prefixes
`https://basescan.org/tx/` to `action.tx` and basescan-clickthrough
credibility breaks if hashes are fabricated. B5 implements the hybrid:

- **Chain-derived actions.** The indexer extends its log subscription to
  `LiquidityAdded` / `LiquidityRemoved` / `Swapped` / `FeesCollected` /
  `PositionTracked` / `PositionUntracked` and dispatches each to
  `topics/agent.ts` via `subscribeAgentActions`. The bridge translates
  every event into a `WireMessage` with:
  - `id = chain_<10-digit blockNumber>_<4-digit logIndex>` (deterministic)
  - `tx` = the full 66-char on-chain tx hash, lowercased
  - `chip` = `{ type: "pair", left: token0Sym, right: token1Sym }` derived
    from the pool's orientation (`USDC/<nonBase>` or vice versa per
    `usdcIsToken0`); for `Swapped`, `right = tokenOutSym` derived from
    orientation (USDC paired pools — if `tokenIn === USDC` then
    `tokenOut = nonBase`, else `tokenOut = USDC`)
  - `category` ∈ `{ swap, edit_position, claim_fees }` per event kind
  - `text` humanises raw amounts to 4 sig figs with K/M/B suffixes; token
    decimals come from a small in-process table (USDC=6, USDT=6, ETH=18,
    BTC=8, UNI=18; unknown → 18 with a one-shot warning)
  - `thought` is left undefined for B5
- **Bridge registration.** `startAgentActionBridge()` runs once after
  `startIndexer()` returns. Backfill events are intentionally NOT
  bridged — only incremental events from `indexUpToHead` ticks. This
  keeps boot from flooding the priming ring with thousands of historical
  actions; live demo activity flows in normally as new blocks arrive.
- **Scripted signals/replies still run.** The 30s signal broadcaster and
  the canned-reply bot are unchanged. Action events are the only kind
  that come exclusively from chain.
- **Mock priming is signal-only.** `mocks/agent-script.ts:primingHistory`
  no longer emits any `kind: "action"` entries; the three seed entries
  are all signals.
- **Block timestamps.** `applyLogs` pre-fetches unique block timestamps
  per chunk in parallel (concurrency 5) and reuses a process-lifetime
  cache, so backfill stays under public Base RPC's burst budget and
  incremental ticks pay zero RPC after the cache is warm.

### Limitations

- **No backfill replay.** Historical actions older than boot are not
  surfaced on the agent topic — the bridge is registered AFTER backfill
  completes. Cross-boot replay still works for events that landed in the
  ring during the previous run (B6).
- **No real-USD valuation.** Swap text shows raw token amounts in/out;
  USD notional requires a price oracle and lands with B3c.
- **Unknown token addresses fall back to "USDC".** Adding pools paired
  with tokens not in `chain.ts:TOKEN_BY_ADDRESS` will log a one-shot
  warning and render the chip with USDC on the unknown side. Update the
  table when wiring a new pool.

## Persistence (B6)

Every piece of mutable backend state lives in a single sqlite file at
`ALP_DB_PATH` (default `./data/alp.sqlite`). The DB is opened in WAL mode
with `synchronous = NORMAL`. Migrations are idempotent `CREATE TABLE IF NOT
EXISTS` statements that run on every boot from `src/db.ts`.

### What's in the file

| table              | what it holds                                                                                       |
|--------------------|-----------------------------------------------------------------------------------------------------|
| `agent_ring`       | last ≤500 `WireMessage`s + their insertion `seq` + recipient (NULL = vault-global broadcast).       |
| `indexer_state`    | key/value cursors. Today: `last_indexed_block`.                                                     |
| `balances`         | per-wallet share balance (bigint as decimal string).                                                |
| `lots`             | per-wallet basis lots (FIFO consumed by withdraws). Lot index never reuses across consumed lots.    |
| `activity`         | per-wallet deposit/withdraw rows, capped at 100 most-recent per wallet. id = `txHash:logIndex`.     |
| `fee_events`       | windowed USDC fee events for `basketEarned30d` / `basketApr` / `apr30d`.                            |
| `pool_orientation` | per-poolKey `(nonBaseToken, usdcIsToken0)` so action chips render even after restart.               |
| `block_ts`         | block-number → timestamp cache. Backfill prefetch warms it; survives reboot.                        |
| `first_deposit`    | per-wallet "days held" anchor (earliest surviving lot's tsMs).                                      |
| `auth_nonces`      | issued SIWE nonces + consumed flag. Restart no longer makes a recently issued nonce replayable.     |

### Boot semantics

1. `src/db.ts` is imported first, which opens the file (creating its parent
   dir if needed) and runs migrations.
2. `loadAuthState()` and `loadAgentRingState()` rehydrate the in-memory
   maps from sqlite.
3. In chain mode, `startIndexer()` rehydrates the indexer's state, reads
   `last_indexed_block` from `indexer_state`, and resumes backfill from
   `cursor + 1`. If no cursor exists, falls back to `VAULT_DEPLOY_BLOCK`
   (env) or `head − 100_000` (~2.3 days).
4. Mock mode skips indexer load — mock state isn't worth persisting.
5. Every event chunk is folded inside one sqlite transaction that also
   advances the cursor — a crash mid-batch resumes cleanly on the next
   boot. Empty incremental ticks still advance the cursor so a quiet
   vault doesn't replay the same range every restart.

### Manual restart-replay test

Smoke flow 5 covers write-through end-to-end (asserts a captured reply
id is present in `agent_ring`) but doesn't bounce the server. To exercise
cursor replay manually:

```bash
# 1. Start the server, send a user_message, capture the reply id from the
#    server log (or via scripts/smoke.ts).
bun run dev
# … in another shell …
bun run scripts/smoke.ts

# 2. Stop the server (Ctrl-C). Inspect the file.
sqlite3 data/alp.sqlite "SELECT seq, id, kind FROM agent_ring ORDER BY seq DESC LIMIT 5;"

# 3. Restart, then reconnect a WSS client with `since.agent=<reply_id>` —
#    the history frame returns events strictly newer than that id.
bun run dev
```

In chain mode, `[indexer] boot from sqlite: …` logs the rehydrated counts
and cursor on every restart.

### Hackathon limitations

- **No multi-process / horizontal scaling.** Two backend processes
  pointed at the same db file is undefined.
- **No schema migration framework.** Schema changes after B6 require
  explicit `ALTER TABLE`s added inline in `src/db.ts` below the CREATE
  block.
- **No reorg-aware rollback.** Base soft-finalises at ~2 blocks; if a
  reorg invalidates an already-folded event we'd carry stale state until
  manual `data/alp.sqlite` deletion.
- **No backups / encryption at rest.** Operational concerns for B7.
- **No replay of pre-boot chain actions on the agent topic.** Events
  ingested during backfill aren't bridged into the ring (would flood
  priming on first run after a long downtime). Forward events do go in.

## Topics served (B5)

- **`vault`** — `snapshot` on subscribe (chain headlines + 30d trails +
  indexer-derived users / earned / APR / apr30d when available, mock for
  allocations + pools); partial `tick` every 5s when any of
  `sharePrice` / `tvl` / `users` / `basketApr` / `basketEarned30d` cross
  its epsilon. In mock mode (no `VAULT_ADDRESS`/`BASE_RPC_URL`), reverts
  to the B1/B2 random-walk ticker.
- **`agent`** — priming `history` of seeded signal events (signal-only
  since B5) plus any real chain actions accumulated since boot. Live
  `signal` events broadcast every ~30s. Live `action` events emit as the
  indexer folds chain logs (cadence is "as fast as Base produces vault
  txs" — bursty on activity, zero on a quiet chain). User `user_message`
  frames echo + canned reply round-trip is unchanged.
- **`user`** — `snapshot` on subscribe (only if accepted), assembled from
  chain state in chain mode (B4) or the B1 mock seed in mock mode.
  Re-emitted on every settled deposit / withdraw for the wallet, plus a
  debounced re-emit when the live share price moves enough.

## Frame log

Every inbound and outbound frame logs one line:

```
[ws cid=<id> dir=in|out] type=<...> ...
```

Disable by setting `DEBUG_FRAMES=0`.

## Conventions chosen where the contract is silent

- **Unauth `user` rejection.** Contract §2 reads literally as "closed with
  `4003`" when an unauthenticated client subscribes to `user`. We
  deliberately diverge: `user` is rejected via the `ack.rejected` array
  with reason `auth_required`, and the connection stays open. The other
  topics in the same `subscribe` (e.g. `agent`, `vault`) are still
  accepted. **FE lead clarification 2 (2026-04-29) ratified this pattern**:
  recoverable failures should be non-fatal so a single tab can run as
  anon → SIWE-up mid-session without reconnecting. Hard `4003` close is
  reserved for principal/topic mismatches that cannot be recovered by
  re-subscribing on the same connection.
- **Re-subscribe carrying a token while already authed.** Ignored. The
  wallet does not switch mid-connection — the FE must reconnect to bind
  a different wallet. Logged at debug level.
- **Unsubscribe ack.** Not sent. The connection's active set is silently
  updated.
- **History cursor.** Cursors compare against an in-memory insertion-sequence
  map (id → seq), not a lexicographic id compare — so a cursor at a
  `user_message` `clientId` correctly resolves all later ULID-id events
  on reconnect. If the cursor is no longer in the ring (evicted, never
  existed, or malformed), the server replays all visible entries rather
  than dropping events.
- **Ping cadence.** ~30s per connection.

## Rate limit (B7)

The public `user_message` path carries the only client→server frames that
allocate ring entries and trigger downstream agent work, so it's the only
path with a server-side cap. Per WS connection:

- Token bucket, **capacity 20**, refill rate **1 token / 3s** ⇒ 20-burst,
  ~20/min sustained. Tokens are floats; refill is computed lazily on each
  arrival, so there's no per-connection timer.
- On bucket exhaustion: emit `error` frame with `code: "rate_limited"` and
  `message: "user_message rate limit exceeded; retry shortly"`. The
  connection stays open — same recoverable-error pattern as `auth_required`
  / `not_subscribed`. Clients should pause briefly and resume.
- `subscribe` / `unsubscribe` / `ping` are **not** rate-limited at this
  layer; they're cheap and part of the lifecycle.
- `/auth/*` is **not** rate-limited at this layer. SIWE nonces are
  single-use with a 10-minute TTL, and `/auth/dev-token` is env-gated;
  per-IP HTTP limits, if needed, belong in the upstream reverse proxy.

State is stored on the per-connection `ConnState` and GC'd with the
connection on close — no global state.

## Agent ingest API (B7)

The agent server (separate, post-B7 track) lives on a private host and
publishes signals + replies to this backend over a shared-secret-authenticated
seam. Three endpoints, all under `/ingest/*`:

| route                     | type | meaning                                                                  |
|---------------------------|------|--------------------------------------------------------------------------|
| `POST /ingest/signal`     | HTTP | publish a vault-global `signal` `WireMessage`                            |
| `POST /ingest/reply`      | HTTP | publish a private `reply` `WireMessage` to a wallet                      |
| `WSS  /ingest/stream`     | WS   | register as a forward subscriber; receive every accepted `user_message`  |

Action `WireMessage`s are **not** publishable here — they continue to
come exclusively from the chain via the indexer (FE clarification 4:
`action.tx` must be a real on-chain hash). `/ingest/*` covers signals,
replies, and user-message forwarding; nothing else.

Auth: `Authorization: Bearer <INGEST_SECRET>` for HTTP; `?secret=<INGEST_SECRET>`
for the WS upgrade. Constant-time compare via `crypto.timingSafeEqual`.
On bad WS secret, the upgrade is accepted then immediately closed with
WS code `4001` (some clients can't introspect HTTP-status rejections of
the upgrade itself). `INGEST_SECRET` is required at boot, ≥32 chars —
the server exits if absent or too short.

CORS is deliberately **not** configured for `/ingest/*`. The agent host
is private; no browser ever calls these directly. A developer testing
from a browser can curl from the VM.

### Examples

```bash
# Signal — broadcast to every agent subscriber.
curl -s -X POST http://localhost:8787/ingest/signal \
  -H "authorization: Bearer $INGEST_SECRET" \
  -H "content-type: application/json" \
  -d '{"text":"Idle reserve below 12% target — increasing USDC weight."}'
# → {"id":"01HZK6...26charULID"}

# Reply — delivered only to subscribers bound to this wallet (case-insensitive).
curl -s -X POST http://localhost:8787/ingest/reply \
  -H "authorization: Bearer $INGEST_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "wallet":"0x1234567890123456789012345678901234567890",
    "text":"Pool already at target. Holding.",
    "replyTo":"c_abc_def123",
    "sources":[{"kind":"vault","label":"addLiquidity","tx":"0x..."}]
  }'
# → {"id":"01HZK6..."}

# Forward stream — every accepted public user_message arrives here as
# {v:1, type:"forward", wallet, clientId, text, ts}.
websocat "ws://localhost:8787/ingest/stream?secret=$INGEST_SECRET"
```

### Routing

Replies fan out to **every** connection bound to the target wallet — the
user might have multiple browser tabs open. The ring stores the message
once regardless. If no subscriber for the wallet is connected, the
message still lands in the ring and replays on the next reconnect via
`subscribe.since.agent`.

The forward stream supports **any number** of agent clients sharing the
single `INGEST_SECRET` — no role separation, no connection cap. If no
agent is connected when a `user_message` arrives, the existing canned-reply
fallback in `topics/agent.ts:handleUserMessage` still runs (the agent
track will eventually replace that path; B7 just adds the seam). There
is **no offline queue** for forwarded messages — agents that come up
late see only future traffic.

## Deploy (B7)

The Linux-VM target ships with a systemd unit + runbook under
[`deploy/`](deploy/). At a glance:

- [`deploy/alp-backend.service`](deploy/alp-backend.service) — the
  systemd unit. Runs as `alp:alp`, hardened with `ProtectSystem=strict`,
  `NoNewPrivileges=true`, etc. Writes to `/var/lib/alp` and
  `/home/alp/alp/backend` only.
- [`deploy/README.md`](deploy/README.md) — full runbook from a fresh VM
  through `systemctl enable --now alp-backend`, plus a Caddy one-liner
  for TLS termination and a production checklist.

`SIGTERM` (what `systemctl stop` sends) and `SIGINT` (Ctrl-C) trigger
graceful shutdown:

1. New `/stream` and `/ingest/stream` upgrades return `503`.
2. A best-effort `ping` is sent to existing subscribers.
3. `db.close()` flushes the WAL.
4. `process.exit(0)` after a 2s drain (or immediately if no connections).
   `Restart=on-failure` skips exit `0`, so a clean stop doesn't loop.

Production checklist (mirrored in [`deploy/README.md`](deploy/README.md)):

- [ ] `JWT_SECRET` is a fresh 48+ byte random.
- [ ] `INGEST_SECRET` is a fresh 48+ byte random, distinct from `JWT_SECRET`.
- [ ] `AUTH_DEV_BYPASS=0`.
- [ ] `ALP_DB_PATH=/var/lib/alp/alp.sqlite` (the WorkingDirectory becomes
      read-only under `ProtectSystem=strict`).
- [ ] TLS terminates upstream — **don't** expose `8787` to the public
      internet directly. Caddy is the recommended proxy (one-line
      Caddyfile + automatic ACME).
- [ ] `EXPECTED_DOMAIN` / `EXPECTED_URI` / `CORS_ALLOW_ORIGIN` match the
      production frontend origin exactly.
- [ ] `/ingest/*` is restricted to the agent host (private network, ACL
      at the proxy, or both).

## Out of scope for B7

- Allocations + pools from chain (`PoolRegistry` + adapter walk) — B3c.
- Spot pricing of non-USDC tokens for fee revenue and swap notionals — B3c.
- EOD rollover / daily resampling of `apr30d` — later.
- Basis migration on peer-to-peer share transfers — see B4 limitations.
- "Thought" content on action `WireMessage`s — left undefined; future
  agent integration may populate.
- Replaying scripted actions in mock mode — gone permanently.
- Multi-process / horizontal scaling, schema migrations, backups,
  reorg-aware rollback, encryption at rest — see [Persistence (B6)](#persistence-b6).
- Multiple ingest agents with role separation. One `INGEST_SECRET`,
  any-number-of-clients. Distinguishing agents requires either separate
  secrets at a future revision or out-of-band identity (e.g. mTLS).
- Persistent forward-subscriber queue. If no agent is on
  `/ingest/stream`, the user_message falls through to the canned-reply
  path; it isn't queued for a future agent connection.
- Per-IP HTTP rate limits. The token bucket lives on the WS connection,
  not at the HTTP layer; HTTP-side limits, if needed, belong in the
  upstream proxy.
- Distributed tracing / metrics / sentry. stdout (journal) + `/health`
  is the entire observability surface this phase.
- Container builds. systemd is the only deploy primitive.
