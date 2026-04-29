# How the agent monitors positions

This is the contract between the agent and ALPVault. If you're wiring a UI
or another keeper, this is the only file you need to read end-to-end.

## One tick at a glance

```
runTick()
   │
   ├── snapshotPositions()    ← monitor.ts: read every tracked position from chain
   ├── planAll()              ← planner.ts: hysteresis state machine → hold | wait | rebalance
   ├── for each rebalance:
   │      executeRebalance()  ← executor.ts: remove → swap → add (sequenced txs)
   ├── persistHysteresis()    ← KV (prod) or memory (local)
   └── persistActivityLog()   ← one structured row per touched position
```

Output: a JSON array of `Plan` records. The deployed worker returns this verbatim from `POST /trigger` — KeeperHub uses it directly.

## Stage 1 — `snapshotPositions` (monitor.ts)

Read-only. Builds a `PositionSnapshot` per tracked position:

```ts
interface PositionSnapshot {
  pool: PoolConfig;          // labels, decimals, hooks — from pools.local.json
  positionId: bigint;
  tickLower: number;         // position's range
  tickUpper: number;
  liquidity: bigint;
  currentTick: number;       // pool spot at read time
  inRange: boolean;          // tickLower <= currentTick < tickUpper
  outOfRangeDistance: number; // ticks to nearest edge; 0 when in range
}
```

Source of truth per pool kind:

| Pool kind | Position list | Position state | Pool tick |
|---|---|---|---|
| **V3** | `vault.getPositionIds(lpKey)` | `NPM.positions(positionId)` (fee-tier from registry) | `IUniswapV3Pool.slot0().tick` via factory lookup |
| **V4** | `vault.getPositionIds(lpKey)` | `V4PositionManager.getPositionLiquidity` + `getPoolAndPositionInfo` | `PoolManager.extsload(slot0Slot)` where `slot0Slot = keccak(poolId, V4_POOLS_SLOT=6)` |

V4 uses `extsload` (raw storage read) rather than a typed view because v4-core stores the pool state packed and exposes it via `StateLibrary` helpers — replicating the slot math in TS lets us read in one RPC call without a typed contract binding for every field. The slot index `6` is cross-checked against `v4-core/src/libraries/StateLibrary.sol`.

## Stage 2 — `planAll` (planner.ts)

Pure function. Takes (config, snapshots, prior hysteresis state) → list of plans. No I/O.

Hysteresis state machine, per position:

```
                            ┌─────────────┐
                       ┌────│   hold      │←──── inRange
                       │    └─────────────┘
                       │           │ position drifts out
                       │           ▼
                       │    ┌─────────────────────────┐
                       │    │ wait (streak=1)         │ ← first out-of-range obs
                       │    │ first_out_distance = D  │   (always wait one tick)
                       │    └─────────────────────────┘
                       │           │
                       │   tick later, still out…
                       │           │
                       │           ├───── distance < D × CLOSER_FRACTION ──→ wait (price returning)
                       │           │
                       │           └───── otherwise ─────────────────────→ rebalance
                       │                                                    │
                       │                                                    ▼
                       │                                  pick newTickLower / newTickUpper from
                       │                                  pool's volatility profile (config.ts)
                       │                                  centred on current tick, snapped to
                       │                                  pool.tickSpacing
                       │                                                    │
                       └────────────────────────────────────────────────────┘
```

Tunables (env vars on the worker):
- `HYSTERESIS_N` — how many out-of-range obs trigger rebalance (default: 2).
- `HYSTERESIS_CLOSER_FRACTION` — if observation N+1 is < this fraction of the distance at obs 1, wait another tick (default: 0.5 → "if we're more than halfway back, wait").

Width per position is derived from its pool's `profile`:

| Profile | Half-width | Use for |
|---|---|---|
| `stable` | ±2 ticks | USDC/USDT, USDC/DAI |
| `low` | ±5% | Correlated assets |
| `mid` | ±10% | USDC/WETH, USDC/cbBTC |
| `high` | ±20% | Long-tail / volatile |

## Stage 3 — `executeRebalance` (executor.ts)

Three sequential txs per position, each awaited:

1. **`vault.executeRemoveLiquidity(lpKey, positionId, liquidity, 0, 0, extra)`** — peels everything, auto-collects fees, burns the NFT.
2. **`maybeSwapToBalance()`** — if remove leaves the vault one-sided (e.g. position drifted to the edge), swap half of the heavier side into the lighter side via `URAdapter` (Trading API → Universal Router). Skipped when both sides are positive.
3. **`vault.executeAddLiquidity(lpKey, bal0, bal1, 0, 0, extra)`** — opens the new position centred on spot. For V4 pools we pre-quote liquidity locally with the same `LiquidityAmounts` math the on-chain `_quoteLiquidity` uses, then shrink `(bal0, bal1)` to amounts that hit a non-zero quote — V3 doesn't need this because its on-chain mint handles limiting-side selection and refunds the rest.

Per-pool concurrency lock: `inflight: Set<positionKey>` rejects re-entry for the same position while a tick is mid-flight.

Per-call cap (off-chain optimization): `valueInBase()` prices the would-be add against the pool's `maxAllocationBps` from the registry; scales `(bal0, bal1)` down if the cap would otherwise be tripped on-chain. Native-ETH V4 pools substitute WETH + V3 fee-500 for the spot lookup since `factory.getPool(0, USDC, V4_DYNAMIC_FEE)` returns address(0).

## Stage 4 — Activity log (log.ts)

One row per touched position per tick:

```jsonc
{
  "ts": 1777455480,                            // unix seconds
  "positionKey": "0x...:5040741",              // lpKey:positionId
  "pool": "USDC/cbBTC 0.05% (V3)",
  "currentTick": -67432,
  "range": [-68000, -66000],
  "inRange": false,
  "outOfRangeStreak": 2,
  "action": "rebalance",                       // hold | wait | rebalance
  "reason": "out of range for 2 obs",
  "newRange": [-67460, -65540],                // present iff action=rebalance
  "steps": [                                   // present iff action=rebalance
    { "kind": "remove", "txHash": "0x...",  "detail": { "positionId": "5040741" } },
    { "kind": "swap",   "txHash": "0x...",  "detail": { "tokenIn": "0x...", "tokenOut": "0x...", "amountIn": "...", "amountOutMin": "...", "route": "trading-api" } },
    { "kind": "add",    "txHash": "0x...",  "detail": { "newTickLower": -67460, "newTickUpper": -65540 } }
  ]
}
```

UI-side: poll `GET /agent/activity?limit=50` for the live feed. `txHash` of `0x000...000` with `detail.skipped == "true"` means the agent intentionally skipped that step (e.g. V4 add when computed liquidity would be dust) — no on-chain tx happened.

## Inputs (env / config)

Required for `POST /trigger`:
- `BASE_RPC_URL`
- `VAULT_ADDRESS`, `REGISTRY_ADDRESS`, `V3_ADAPTER_ADDRESS`, `V4_ADAPTER_ADDRESS`, `UR_ADAPTER_ADDRESS`
- `AGENT_PRIVATE_KEY` — anvil account 1 locally; a guarded hot key in production
- `HMAC_SECRET` and/or `KEEPERHUB_API_KEY` for write-endpoint auth
- `POOLS_JSON_PATH` (local) or inline `pools` config — see [pools.local.json](./pools.local.json) for the format

Optional tunables: `SWAP_SLIPPAGE_BPS`, `LIQUIDITY_SLIPPAGE_BPS`, `HYSTERESIS_N`, `HYSTERESIS_CLOSER_FRACTION`, `TRADING_API_BASE`, `TRADING_API_KEY`, `V4_POOL_MANAGER_ADDRESS` (defaults to canonical Base address).

## What the agent will NOT do

- It never holds the user's funds; every flow runs through the vault's `onlyAgent` entry points.
- It never swaps without `amountOutMin > 0` (vault enforces).
- It never opens a position outside the registered `(token0, token1, fee, tickSpacing, hooks)` tuple — the lpKey from `pools.local.json` must match the registry hash.
- It never rebalances on the same block as a deposit, redeem, or any other agent op — the vault's `_lastMintBlock` lockout enforces this.
- It never collects fees as a separate flow — fees auto-collect during `removeLiquidity` and during the vault's own per-call `_harvestAllPositions`.
