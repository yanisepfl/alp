# ALPS Agent

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

Three depth tiers. Pick whichever matches the time you have.

### Tier 1 — Workflow built in the UI (10 min)

KH's REST `/api/workflows/create` accepts `(name, nodes, edges)` shape but the per-node action `type` + `config` schema isn't documented in REST (only via MCP `list_action_schemas`). Auto-deploying nodes verbatim creates empty shells. So the production path is: build once in the UI, snapshot via `pnpm deploy:keeperhub download`, commit the result, PATCH for future edits.

**Build steps in [app.keeperhub.com](https://app.keeperhub.com) → Workflows → New workflow:**

1. **Trigger node**: pick `Schedule`, set cron `*/5 * * * *`.
2. **Add HTTP Request node** named `tick`:
   - Method `POST`
   - URL `https://${ALPS_WORKER_URL}/trigger`
   - Headers: `Authorization: Bearer ${ALPS_API_KEY}`, `Content-Type: application/json`
   - Body `{}`
3. **Add Condition node** named `did_rebalance`:
   - Expression `$.tick.body.rebalances > 0`
4. **Add Telegram node** named `notify_success` (downstream of Condition's `true` branch):
   - Bot token `${TG_BOT_TOKEN}`, chat id `${TG_CHAT_ID}`, parse mode Markdown
   - Text: `*ALPS rebalanced ${$.tick.body.rebalances} position(s)* — ${$.tick.body.plans[*].pool}`
5. **(Optional) Add Telegram node** named `notify_failure` on the HTTP node's `failure` edge with text `⚠️ ALPS tick failed`.
6. Define the four workflow secrets in **Settings → Secrets**: `ALPS_WORKER_URL`, `ALPS_API_KEY`, `TG_BOT_TOKEN`, `TG_CHAT_ID`.
7. Click **Go Live**.

**Then snapshot it:**
```bash
cd agent
set -a && source .env.local && set +a
pnpm deploy:keeperhub download           # writes keeperhub-workflow.live.json
git add agent/keeperhub-workflow.live.json && git commit -m "snapshot KH workflow"
```

`pnpm deploy:keeperhub status` lists existing workflows. `pnpm deploy:keeperhub patch` PATCHes the live workflow from `keeperhub-workflow.live.json` for future edits. `pnpm deploy:keeperhub clean` deletes any duplicates.

### Tier 2 — KH Turnkey signs every rebalance tx (Best Integration depth)

With `KEEPERHUB_DIRECT_EXEC=true`, the worker routes all rebalance writes (`executeRemoveLiquidity` → `executeSwap` → `executeAddLiquidity`) through KH's Direct Execution API. KH's Turnkey-backed wallet appears as `msg.sender` on Basescan — the worker no longer needs `AGENT_PRIVATE_KEY` at runtime.

**Setup:**
1. Get the Turnkey wallet address: `curl https://app.keeperhub.com/api/integrations -H "Authorization: Bearer kh_..."` returns `{walletAddress: "0x..."}`. Confirmed `type: "web3"` (no USDC-only allowlist; can call arbitrary contracts).
2. Send the wallet ~0.005 ETH on Base for gas: `cast send <walletAddress> --value 0.005ether ...`
3. Grant it the vault's `agent` role: `vault.setAgent(walletAddress)` (owner-only).
4. Set worker env: `pnpm wrangler secret put KEEPERHUB_DIRECT_EXEC` and paste `true`.
5. Re-deploy: `pnpm run deploy:worker`.

Demo proof: vault.agent() returns the Turnkey address; Basescan tx trace shows the Turnkey EOA as `From`.

### Tier 3 — Operate ALPS via KeeperHub MCP (deepest)

KH hosts an MCP server at `https://app.keeperhub.com/mcp`. Connecting any MCP client (Claude Code, Cursor, custom) lets you manage the workflow via natural language tool calls (`list_workflows`, `execute_workflow`, `get_execution_logs`, `list_action_schemas`, etc.).

```bash
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_..."
```

Then in Claude: "list my keeperhub workflows", "trigger ALPS Rebalance Loop", "show me the last 5 executions". This satisfies the prize's "MCP server" qualifying-integration call-out without writing any code.

### Telegram secrets

- `TELEGRAM_BOT_TOKEN`: DM @BotFather → `/newbot` → follow prompts → copy the token.
- `TELEGRAM_CHAT_ID`: DM your bot once, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → read `"chat":{"id":<NUMBER>}`.
