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

## Local run

```bash
cp .env.example .env
# fill in values
pnpm install
pnpm local
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

Then point KeeperHub at `https://<your-worker>.workers.dev/trigger` with HMAC-SHA256 signing (header `x-signature`).
