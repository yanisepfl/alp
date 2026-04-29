# KeeperHub Setup — ALP Agent

[KeeperHub](https://docs.keeperhub.com/) is the ALP agent's production scheduler: it fires `POST /trigger` against the deployed worker every N minutes. The agent itself remains stateless (state lives in the on-chain vault and the worker's KV); KeeperHub's job is purely **when to wake it up** and **what to alert on**.

## Why KeeperHub (not a plain cron)

- **Non-custodial signing** — workflows run under a Turnkey-backed wallet without us shipping a long-lived hot key.
- **Retry + back-off + dead-letter** — a transient RPC outage doesn't drop a tick.
- **Observability** — every tick emits a run record we can pipe to Discord / Telegram / a status page from the same workflow graph.
- **Conditional execution** — the workflow can short-circuit on `runTick` returning `{"rebalances": 0}` to avoid downstream noise.

## Prerequisites

1. ALP worker deployed (see [README.md](./README.md#deploy)).
2. KeeperHub account at [app.keeperhub.com](https://app.keeperhub.com).
3. A long-random `KEEPERHUB_API_KEY` set as a worker secret:
   ```bash
   pnpm wrangler secret put KEEPERHUB_API_KEY
   ```

## Workflow recipe

In `app.keeperhub.com → Workflows → New workflow`, build:

```
[Schedule trigger]      every 5 minutes  (cron: */5 * * * *)
        │
        ▼
[Send Webhook]          POST  https://<worker>.workers.dev/trigger
                        Headers:
                          Authorization: Bearer {{ secrets.ALP_API_KEY }}
                          Content-Type:  application/json
                        Body: {}
        │
        ▼
[Condition]             $.body.rebalances > 0
        │  true
        ▼
[Notify Discord]        "ALP rebalanced {{$.body.rebalances}} position(s):
                         {{ $.body.plans }}"
```

Store the worker's `KEEPERHUB_API_KEY` as a KeeperHub secret (`ALP_API_KEY`) so it isn't visible in the workflow graph.

## Verifying the integration

```bash
# 1. Worker liveness from KeeperHub's perspective:
curl https://<worker>.workers.dev/agent/health

# 2. Manual auth check (matches what KeeperHub will send):
curl -X POST https://<worker>.workers.dev/trigger \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  -d '{}'
# Expected: 200 with the runTick JSON
```

If you see `401 unauthorised`, double-check the secret on both sides matches exactly (no trailing newline).

## Optional: deeper integration via Direct Execution API

For the **Best Integration** prize tier, replace the agent's local viem signer with [KeeperHub's Direct Execution API](https://docs.keeperhub.com/api/execute/contract-call) for `executeRemoveLiquidity` / `executeAddLiquidity` calls. Trade-offs:
- ✅ Tx signing handled by KeeperHub Turnkey wallet (no hot key in the worker).
- ✅ Built-in MEV protection + simulation + retries.
- ❌ Requires authoring the contract-call payloads in the workflow graph rather than the executor.

We left this out of the v1 path since the existing executor already handles the tightly-coupled remove → swap → add sequencing. Worth revisiting once positions are open on mainnet and the rebalance cadence stabilises.

## Operational alerts to wire next

These each map to a one-node KeeperHub workflow with `Send Webhook` + `Condition`:

| Alert | Endpoint | Fire when |
|---|---|---|
| Position out of range > 30 min | `GET /agent/dryrun` | `$.plans[*].action == "wait"` for two consecutive ticks |
| Rebalance failed | `GET /agent/activity?limit=5` | most recent row has `errors[*]` non-empty |
| Vault total assets drop > 5% in 1h | `GET /agent/health` + custom RPC call to `vault.totalAssets()` | computed delta > threshold |
