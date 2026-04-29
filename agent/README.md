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
pnpm run deploy:worker
```

(`pnpm deploy` without the script name triggers pnpm's monorepo `deploy` builtin, which fails with `ERR_PNPM_CANNOT_DEPLOY` outside a workspace. Always use `pnpm run deploy:worker` to invoke the script in `package.json`.)

## KeeperHub integration

Two depth tiers. The basic tier ships out of the box; the deep tier (KH-Turnkey signing every rebalance tx) is one env-var flip away.

### Basic — schedule + Telegram notifications (5 min)

The repo ships [`keeperhub-workflow.json`](./keeperhub-workflow.json) and an idempotent deploy script. After `wrangler deploy` of the worker:

1. Get a KeeperHub org API key: app.keeperhub.com → Settings → API Keys → New key (`kh_…`).
2. Drop env vars in `agent/.env.local` (gitignored):
   ```
   KEEPERHUB_API_KEY=kh_...
   ALP_WORKER_URL=alp-agent.username.workers.dev
   ALP_API_KEY=long_random_string
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
3. `pnpm wrangler secret put KEEPERHUB_API_KEY` and paste the **same** `ALP_API_KEY` (the worker uses it to verify KH-originated requests).
4. `pnpm deploy:keeperhub` — POSTs `/api/workflows/create` + PATCHes nodes/edges + activates. Idempotent (re-run to update).

Workflow logic: every 5 min `POST /trigger` → if `rebalances > 0` → Telegram with the per-pool reason + new range to your private chat. Failure branch alerts the same chat if the worker errors.

### Deep — KH Turnkey signs every rebalance tx (Best Integration tier)

When `KEEPERHUB_DIRECT_EXEC=true` is set, the worker routes all three rebalance writes (`executeRemoveLiquidity` → `executeSwap` → `executeAddLiquidity`) through KH's Direct Execution API. KH's Turnkey-backed wallet appears as `msg.sender` on-chain — the worker no longer needs `AGENT_PRIVATE_KEY` at runtime.

Setup:
1. Get the Turnkey wallet address: app.keeperhub.com → Settings → Wallets / Org Wallet (open question — see local notes if not visible).
2. Grant it the vault's `agent` role: `vault.setAgent(turnkeyAddress)` (owner-only).
3. Set worker env: `pnpm wrangler secret put KEEPERHUB_DIRECT_EXEC --value true` and `pnpm wrangler secret put KEEPERHUB_API_KEY --value kh_...`.

The activity log + Telegram messages now show the Turnkey wallet's tx hashes. Demo proof: take a screenshot of `vault.agent()` returning the Turnkey address before the rebalance + Basescan trace of the tx with Turnkey EOA as From.

### Telegram secrets — exactly how to obtain

- `TELEGRAM_BOT_TOKEN`: DM @BotFather → `/newbot` → follow prompts → copy the token (looks like `7912345678:AAFmM…`).
- `TELEGRAM_CHAT_ID`: DM your new bot once, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates` and read `"chat":{"id":<NUMBER>}` — that's your private chat ID.
