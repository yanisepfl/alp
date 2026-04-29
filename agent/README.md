# ALP Agent

Off-chain rebalancer for [ALPVault](../contracts/src/ALPVault.sol). Monitors every tracked LP position, detects out-of-range positions, and rebalances them through the Uniswap Trading API + Universal Router.

## What it does

Each tick (default: every 30 minutes via KeeperHub):

1. Reads each tracked position; checks the live pool tick against the position's range.
2. Hysteresis: a position must be out-of-range for 2 consecutive observations before any action — and if the second observation shows the price returning toward range, the agent waits another tick.
3. On rebalance:
   - `executeRemoveLiquidity` (auto-collects fees, burns the NFT).
   - `executeSwap` through `UniversalRouterAdapter` to balance the one-sided amounts.
   - `executeAddLiquidity` at a new range centred on spot, sized by the pool's volatility profile.
4. Appends a structured row to the activity log (Cloudflare KV in production, in-memory locally).

## Layout

```
src/
├── abi.ts        Hand-rolled ABI fragments (vault, NPM, V3 pool, V3 factory)
├── config.ts     Per-pool config + volatility profiles + agent config loader
├── monitor.ts    Read positions + slot0 → in-range check
├── planner.ts    Hysteresis state machine → hold / wait / rebalance plans
├── quoting.ts    Single-hop V3 calldata builder + Trading API multi-hop client
├── executor.ts   viem signing for remove → swap → add
├── log.ts        Activity log (KV + memory implementations)
├── runner.ts     One full tick: snapshot → plan → execute → persist
├── index.ts      Cloudflare Worker entry (POST /trigger, GET /agent/activity)
└── local.ts      Node entry for ad-hoc local runs
```

## Volatility profiles

| Profile | Width | Use for |
|---------|-------|---------|
| `stable` | ±8 ticks | USDC/USDT, USDC/DAI |
| `low` | ±10% | Correlated assets (USDC/cbETH) |
| `mid` | ±25% | USDC/WETH, USDC/cbBTC |
| `high` | ±50% | Volatile / new pairs |

Set per-pool in the config, not on-chain — easy to retune.

## HTTP surface

| Route | Auth | Description |
|-------|------|-------------|
| `POST /trigger` | HMAC \| Bearer | Normal scheduled tick (KeeperHub fires this every 30 min). |
| `POST /force-rebalance` | HMAC \| Bearer | Demo button: ignore hysteresis and rebalance now. Body `{}` rebalances every position; body `{"positionKey": "..."}` rebalances just one. |
| `GET /agent/dryrun` | none | Read-only: returns the plan the agent would execute against current chain state. Spends no gas. |
| `GET\|POST /agent/plan` | none | Alias of /agent/dryrun for KeeperHub workflow per-plan fan-out. `?force=true` returns the hysteresis-overridden plan. |
| `GET /agent/health` | none | Liveness + public config snapshot. Used by KeeperHub uptime probes. |
| `GET /agent/activity?limit=N` | none | Recent decisions + tx hashes. Frontend feed. |

Auth options on the write endpoints — either is sufficient on its own:
- `x-signature: <hex HMAC-SHA256(body, HMAC_SECRET)>` (CLI / scripted callers)
- `Authorization: Bearer <KEEPERHUB_API_KEY>` (KeeperHub workflow webhook nodes that can't compute HMAC dynamically)

## Local run

```bash
cp .env.example .env
# fill in values
pnpm install
pnpm local                      # one tick, real submission
pnpm local -- --dry             # one tick, plan only (no txs)
pnpm local -- --force           # rebalance every position now
pnpm local -- --force <key>     # rebalance just one position
```

## Deploy

```bash
pnpm wrangler kv:namespace create ACTIVITY_LOG
# update wrangler.toml with the returned id
pnpm wrangler secret put AGENT_PRIVATE_KEY
pnpm wrangler secret put HMAC_SECRET
pnpm wrangler secret put BASE_RPC_URL
pnpm wrangler secret put VAULT_ADDRESS
pnpm wrangler secret put REGISTRY_ADDRESS
pnpm wrangler secret put V3_ADAPTER_ADDRESS
pnpm wrangler secret put UR_ADAPTER_ADDRESS
pnpm deploy
```

## KeeperHub setup

The repo ships [`keeperhub-workflow.json`](./keeperhub-workflow.json) — import into [app.keeperhub.com](https://app.keeperhub.com) (Workflows → Import) and fill the four secrets:

| Secret | Where it comes from |
|---|---|
| `ALP_WORKER_URL` | Your `wrangler deploy` output, e.g. `alp-agent.username.workers.dev` |
| `ALP_API_KEY` | Long random string. Set the same value as `KEEPERHUB_API_KEY` on the worker (`pnpm wrangler secret put KEEPERHUB_API_KEY`). |
| `TG_BOT_TOKEN` | DM @BotFather on Telegram → `/newbot` → copy the token string. |
| `TG_CHAT_ID` | DM your bot once, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates` and look for `"chat":{"id":...}` — that's your private chat ID. |

The workflow fires every 5 minutes, calls `POST /trigger`, and pings the Telegram chat **only when at least one position rebalanced** (with the per-position pool name + reason + new range). A failure-branch sends a separate alert if the worker call errors.

To get a `kh_` org API key (only needed for programmatic workflow management — manual import via UI doesn't need it): in app.keeperhub.com → Settings → API Keys → New key, prefix `kh_`. Paste it as the `Authorization: Bearer <kh_key>` header when calling KeeperHub's REST API or `kh login --api-key <kh_key>` for the CLI.
