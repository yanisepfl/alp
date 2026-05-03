# KeeperHub Feedback

## Context

ALPS is an autonomous concentrated-liquidity vault on Base. **KeeperHub drives the entire keeper loop** — polling tick, reactive audit, operator override — across three workflows checked into the repo as JSON snapshots:

- [`alps-rebalance`](agent/keeperhub-workflows/alps-rebalance.live.json) — Schedule trigger (`*/5 * * * *`, UTC). Reads TVL + pool roster + agent ETH + L2 gas price, gates the keeper call on a dynamic gas floor, posts the outcome (fired or held) back to `/log-tick`.
- [`alps-post-rebalance`](agent/keeperhub-workflows/alps-post-rebalance.live.json) — Blockchain Event trigger on `vault.LiquidityAdded`. Multicall3-batches `poolValueExternal(poolKey)` over all 3 pools and posts the basket-wide audit to the keeper.
- [`alps-demo-rebalance`](agent/keeperhub-workflows/alps-demo-rebalance.live.json) — Manual trigger. "Run now" button for the demo recording and the on-call escape hatch.

## Primitives we used

| Surface | Where |
|---|---|
| Schedule trigger (cron `*/5 * * * *`) | `alps-rebalance` polling tick |
| Blockchain Event trigger (`vault.LiquidityAdded`) | `alps-post-rebalance` reactive audit |
| Manual trigger | `alps-demo-rebalance` "Run now" |
| `web3/read-contract` | TVL, active pool roster, L2 gas price |
| `web3/check-balance` | Agent ETH balance, pre- and post-tick |
| `web3/batch-read-contract` | Multicall3 over 3 pool keys for `poolValueExternal` |
| `math/aggregate` (sum) | Sums batched pool values into a deployed-capital total |
| Condition node | Dynamic gas floor (`agentEth > gasPrice * 14_000_000`) |
| HTTP Request node | Every keeper-bound POST (`/scan`, `/post-rebalance`, `/log-tick`, `/force`) |

## What worked well

- **Schedule and Event triggers cover both halves of the keeper loop with no glue code.** Polling is a cron string; reactive audit is event name + ABI + contract. No coordinator service in between.
- **`web3/batch-read-contract` is a real Multicall3 in one node, and `math/aggregate` composes with it.** Three serial reads collapse into a single round-trip ([line 30-44](agent/keeperhub-workflows/alps-post-rebalance.live.json#L30-L44)), and one `sum` node turns the array into `deployedTotal` ([line 53-65](agent/keeperhub-workflows/alps-post-rebalance.live.json#L53-L65)) without a custom code node.
- **Condition nodes short-circuit cleanly.** Our gas check is a single expression — `{{@read-gas:Read Agent Gas.balanceWei}} > ({{@read-gas-price:Read L2 Gas Price.result}} * 14000000)` ([alps-rebalance.live.json:114](agent/keeperhub-workflows/alps-rebalance.live.json#L114)) — splitting the flow into "fire" vs "log low-gas" without a `/scan` round-trip on tight-gas ticks.
- **Workflows round-trip as exportable JSON.** Each one is a versionable document we can diff in git and PATCH back through the REST API. Having every running config be a reviewable diff is the right hackathon-grade default.

## Issues encountered

### 1. ABIs are double-escaped JSON strings inside JSON config

**Problem:** `contractABI` and `abi` fields are stringified-inside-stringified ([alps-rebalance.live.json:33](agent/keeperhub-workflows/alps-rebalance.live.json#L33), [alps-post-rebalance.live.json:17](agent/keeperhub-workflows/alps-post-rebalance.live.json#L17)). Hand-editing means counting `\\"` density without syntax highlighting.

**Workaround:** Author the ABI in a separate file, `JSON.stringify` it, paste the result.

**Suggestion:** Accept the ABI as a real JSON value in a separate field (e.g. `abiFragment`). Editors get back syntax highlighting, linting, and diff-friendliness.

### 2. Template references duplicate the source of truth

**Problem:** `{{@read-tvl:Read TVL.result}}` carries both the node ID (`read-tvl`) and the human label (`Read TVL`). Either one drifting during a refactor silently breaks the reference.

**Suggestion:** `{{@read-tvl.result}}` (ID only) is enough. The human label belongs in the editor UI, not the wire format.

### 3. Workflow JSON ships UI layout coordinates

**Problem:** `position.x` / `position.y` pollute git diffs whenever a node gets nudged in the editor. Most of our iteration churn was layout, not logic.

**Suggestion:** Either split layout into a sidecar file, or omit it from REST exports by default.

### 4. One trigger per workflow

**Problem:** Polling and reactive are two halves of the same loop, but they live in two workflows because the schema allows exactly one trigger. Cross-workflow shared state (e.g. "last fired at") has to round-trip through the keeper.

**Suggestion:** Multi-trigger workflows, or a workspace-scoped "shared store" primitive.

### 5. No first-class workspace variables

**Problem:** The Cloudflare Tunnel hostname and the keeper bearer end up literal in the workflow JSON. Every tunnel rotation means a download → sed → PATCH cycle on all three workflows.

**Workaround:** Hand-redact our git snapshots into `${KEEPER_PUBLIC_HOST}` / `${KEEPER_INBOUND_BEARER}` placeholders; the redaction is ours, not a runtime feature we verified KH provides.

**Suggestion:** A workspace-scoped variable referenceable from any node config — one update propagates everywhere.

### 6. Bearer auth via URL query string is the path of least resistance

**Problem:** We pass `?token=${KEEPER_INBOUND_BEARER}` on every keeper-bound POST ([alps-rebalance.live.json:131](agent/keeperhub-workflows/alps-rebalance.live.json#L131), [alps-post-rebalance.live.json:96](agent/keeperhub-workflows/alps-post-rebalance.live.json#L96)) instead of an `Authorization: Bearer` header. The HTTP node accepts headers via `httpHeaders`, so this is on us — but query-string tokens show up in any reverse-proxy access log.

**Suggestion:** A header-auth example in the HTTP node docs would nudge users toward the safer default.

### 7. Iteration loop is browser-only

**Problem:** No `keeperhub run --workflow=alps-rebalance --dry-run` we could find. Editing means clicking through the dashboard, saving, reading the result, editing again.

**Suggestion:** A CLI for round-trip dev (export, edit locally, validate, push) would have saved real time.

### 8. Mobile UX is rough

**Problem:** Reviewing workflows on mobile — checking status during demo prep, glancing at the last run on the go — is significantly worse than desktop. The editor is the only surface, and it isn't laid out for narrow viewports.

**Suggestion:** A mobile-friendly read-only view of workflow status (last run, last error, next scheduled fire, fired-vs-held counts) would cover the common "is it still working?" check without forcing the full editor onto a phone screen.

## Summary

The trigger-per-half-of-the-loop split is what made this integration work for us — cron + event + manual covered the entire surface for our use case, with native primitives (`web3/*`, `math/*`, Condition) doing work that would otherwise have been a separate service. Most of the friction we hit clusters around the wire format (it carries editor state — layout coords, label-bearing references, double-escaped ABIs) and the lack of a workspace-scoped variable primitive we could find. Hackathon scope, single integration; sharing it in case any of it is useful.
