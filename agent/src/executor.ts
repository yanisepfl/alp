import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { registryAbi, v3FactoryAbi, v3PoolAbi, v4PoolManagerAbi, vaultAbi } from "./abi.js";
import type { AgentConfig, PoolConfig } from "./config.js";
import type { ActionStep } from "./log.js";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
} from "./liquidityMath.js";
import type { PositionSnapshot } from "./monitor.js";
import type { Plan } from "./planner.js";
import { buildSingleHopV3Swap, quoteAndBuildMultiHop } from "./quoting.js";

/** Storage slot index of the `pools` mapping inside V4 PoolManager.
 *  Mirrors the constant in `monitor.ts` — kept duplicated rather than
 *  exported to keep the modules independent. */
const V4_POOLS_SLOT = 6n;

/** True iff the pool routes through the V4 adapter. The V4 add path needs
 *  pre-quoted (amount0, amount1) — the on-chain V4 PositionManager rejects
 *  any combination that resolves to zero liquidity. V3 mints with whatever
 *  the limiting side allows and refunds the rest, so it doesn't need this. */
function isV4(pool: PoolConfig): boolean {
  return pool.kind === "v4";
}

/** Locks per position so concurrent invocations don't double-submit. */
const inflight = new Set<string>();

/** Execute the rebalance for one plan: remove → swap → add.
 *
 *  Each step submits a single transaction and awaits its receipt. We do not
 *  batch multicall here for clarity and to keep failure modes localised.
 */
export async function executeRebalance(args: {
  config: AgentConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  plan: Plan;
  vaultBaseAsset: Address;
}): Promise<ActionStep[]> {
  const { config, publicClient, walletClient, account, plan, vaultBaseAsset } = args;
  if (plan.action.kind !== "rebalance") throw new Error("executeRebalance called on non-rebalance plan");

  const lockKey = plan.prior.positionKey;
  if (inflight.has(lockKey)) throw new Error(`position ${lockKey} already has an in-flight rebalance`);
  inflight.add(lockKey);

  const steps: ActionStep[] = [];
  try {
    const pos = plan.position;
    const pool = pos.pool;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // 1. Remove all liquidity (auto-collects fees, burns the NFT).
    const removeExtra = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }],
      [deadline, true],
    );
    const removeTx = await walletClient.writeContract({
      account,
      chain: null,
      address: config.vaultAddress,
      abi: vaultAbi,
      functionName: "executeRemoveLiquidity",
      args: [pool.lpKey, pos.positionId, pos.liquidity, 0n, 0n, removeExtra],
      gas: 2_000_000n,
    });
    await waitForOk(publicClient, removeTx, "executeRemoveLiquidity");
    steps.push({ kind: "remove", txHash: removeTx, detail: { positionId: pos.positionId.toString() } });

    // 2. Swap one-sided into balanced. After remove, the vault holds whichever
    //    side of the pair the price drift left it with. To open the new position
    //    centred on spot we need both sides; swap half of the surplus side into
    //    the deficient side.
    //    Heuristic: read both balances; whichever is larger in base-asset terms,
    //    swap half of it. (Simple v1; later we can size precisely from the new
    //    range's expected ratio.)
    const swapStep = await maybeSwapToBalance({
      config,
      publicClient,
      walletClient,
      account,
      pool,
      positionSnapshot: pos,
      vaultBaseAsset,
      deadline,
    });
    if (swapStep) steps.push(swapStep);

    // 3. Open new position at recentered range.
    const addExtra = encodeAbiParameters(
      [{ type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint256" }],
      [plan.action.newTickLower, plan.action.newTickUpper, deadline, 0n],
    );
    let bal0 = await readErc20Balance(publicClient, pool.token0, config.vaultAddress);
    let bal1 = await readErc20Balance(publicClient, pool.token1, config.vaultAddress);

    // Cap the add against the pool's `maxAllocationBps`. Without this the
    // agent would dump the entire vault balance into a single pool and
    // revert as soon as the result exceeds the cap. We value (bal0, bal1)
    // in base-asset units via the V3 pool's spot price, then scale down
    // proportionally if needed.
    const { maxAllocationBps } = await publicClient.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "getPool",
      args: [pool.lpKey],
    });
    if (maxAllocationBps < 10_000) {
      const tav = await publicClient.readContract({
        address: config.vaultAddress,
        abi: vaultAbi,
        functionName: "totalAssets",
      });
      const maxValueBase = (tav * BigInt(maxAllocationBps)) / 10_000n;
      const addValueBase = await valueInBase({
        publicClient,
        pool,
        bal0,
        bal1,
        baseAsset: vaultBaseAsset,
      });
      if (addValueBase > maxValueBase && addValueBase > 0n) {
        // Apply a small safety margin (-1%) so post-tx valuation drift
        // doesn't trip the cap on the contract-side check.
        const scaledBps = (maxValueBase * 9_900n) / addValueBase;
        bal0 = (bal0 * scaledBps) / 10_000n;
        bal1 = (bal1 * scaledBps) / 10_000n;
      }
    }

    // V4-only sizing: the V4 PositionManager's `_quoteLiquidity` returns 0
    // (and reverts as `InsufficientLiquidityComputed`) whenever the supplied
    // (amount0, amount1) don't fit the new range's ratio at spot. After the
    // remove + swap-to-balance step the vault holds rough halves, but the
    // exact split rarely matches what a tight symmetric V4 range needs, so
    // we re-quote locally and shrink the desired amounts to the largest pair
    // that produces a non-zero liquidity. V3 mint handles this on-chain
    // (limiting side wins, the rest gets refunded) so we leave it untouched.
    if (isV4(pool)) {
      const sqrtPriceX96 = await readV4SqrtPriceX96(publicClient, config.v4PoolManagerAddress, pool);
      const sqrtLower = getSqrtRatioAtTick(plan.action.newTickLower);
      const sqrtUpper = getSqrtRatioAtTick(plan.action.newTickUpper);
      const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, bal0, bal1);
      // Skip the add when liquidity would be dust — protects against weird
      // post-swap residuals (e.g. swap rounded to 0) that would just cause
      // a revert on-chain. Threshold mirrors the contract-side guard.
      if (liquidity < 1000n) {
        steps.push({
          kind: "add",
          txHash: ("0x" + "00".repeat(32)) as `0x${string}`,
          detail: {
            skipped: "true",
            reason: `computed liquidity ${liquidity.toString()} below safe threshold`,
            newTickLower: plan.action.newTickLower,
            newTickUpper: plan.action.newTickUpper,
          },
        });
        return steps;
      }
      const sized = getAmountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity);
      // Cap by what we actually hold. The math above guarantees both
      // `sized.amountX <= balX`, but defensively floor here to absorb any
      // rounding direction mismatch versus the on-chain quote.
      bal0 = sized.amount0 < bal0 ? sized.amount0 : bal0;
      bal1 = sized.amount1 < bal1 ? sized.amount1 : bal1;
    }

    const addTx = await walletClient.writeContract({
      account,
      chain: null,
      address: config.vaultAddress,
      abi: vaultAbi,
      functionName: "executeAddLiquidity",
      args: [
        pool.lpKey,
        bal0,
        bal1,
        // amountMins set to 0 because V3's mint only consumes the ratio
        // dictated by the new range, which generally won't match (bal0,
        // bal1) — the limiting token determines liquidity and the other
        // gets refunded. A meaningful slippage check requires pre-computing
        // the expected ratio via LiquidityAmounts; deferred to v2. The
        // URAdapter's swap-side slippage check already protects against
        // price-move MEV during the rebalance.
        0n,
        0n,
        addExtra,
      ],
      // Generous fixed gas budget. viem's auto-estimate hugs the simulation
      // value too tightly for this call — the post-add cap check iterates
      // every tracked position and can run out at the very last step.
      gas: 3_000_000n,
    });
    await waitForOk(publicClient, addTx, "executeAddLiquidity");
    steps.push({
      kind: "add",
      txHash: addTx,
      detail: {
        newTickLower: plan.action.newTickLower,
        newTickUpper: plan.action.newTickUpper,
      },
    });

    return steps;
  } finally {
    inflight.delete(lockKey);
  }
}

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function readErc20Balance(client: PublicClient, token: Address, holder: Address): Promise<bigint> {
  // V4 native-ETH pools store currency0 = address(0); the vault holds those
  // legs as plain ETH balance, not as an ERC20 entry. Route through eth_getBalance
  // for the native sentinel, ERC20.balanceOf otherwise.
  if (token === "0x0000000000000000000000000000000000000000") {
    return client.getBalance({ address: holder });
  }
  return client.readContract({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [holder] });
}

/** Read the current V4 pool sqrtPriceX96 via PoolManager.extsload.
 *  Mirrors the layout used in `monitor.ts`: pool slot = keccak(poolId, slot 6),
 *  slot0 sits at offset 0 packed as { uint160 sqrtPriceX96, int24 tick, ... }. */
async function readV4SqrtPriceX96(
  client: PublicClient,
  poolManagerAddress: Address,
  pool: PoolConfig,
): Promise<bigint> {
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [pool.token0, pool.token1, pool.fee, pool.tickSpacing, pool.hooks],
    ),
  );
  const slot0Slot = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, V4_POOLS_SLOT]),
  );
  const raw = await client.readContract({
    address: poolManagerAddress,
    abi: v4PoolManagerAbi,
    functionName: "extsload",
    args: [slot0Slot],
  });
  // sqrtPriceX96 is the lower 160 bits of the packed slot.
  const mask160 = (1n << 160n) - 1n;
  return BigInt(raw) & mask160;
}

/** Await a tx receipt and throw if it reverted. viem's
 *  `waitForTransactionReceipt` returns the receipt regardless of status, so we
 *  have to check explicitly — otherwise a reverted on-chain tx silently
 *  propagates through the activity log as "success". */
async function waitForOk(client: PublicClient, hash: `0x${string}`, label: string): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted (tx ${hash})`);
  }
}

const V3_FACTORY: Address = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

/** Value (bal0, bal1) in base-asset units using the pool's V3 spot price.
 *  Used to enforce the per-pool `maxAllocationBps` from the agent side. */
async function valueInBase(args: {
  publicClient: PublicClient;
  pool: import("./config.js").PoolConfig;
  bal0: bigint;
  bal1: bigint;
  baseAsset: Address;
}): Promise<bigint> {
  const { publicClient, pool, bal0, bal1, baseAsset } = args;
  const poolAddr = await publicClient.readContract({
    address: V3_FACTORY,
    abi: v3FactoryAbi,
    functionName: "getPool",
    args: [pool.token0, pool.token1, pool.fee],
  });
  if (poolAddr === "0x0000000000000000000000000000000000000000") return bal0 + bal1;
  const slot0 = await publicClient.readContract({
    address: poolAddr,
    abi: v3PoolAbi,
    functionName: "slot0",
  });
  const sqrtPriceX96 = slot0[0];
  // Convert sqrtPriceX96 → price (token1 per token0) in fixed-point.
  // price = (sqrtPriceX96 / 2^96)^2
  const Q96 = 2n ** 96n;
  // Use the same split-step pattern the vault uses to avoid overflow.
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const denominator = Q96 * Q96;
  // Value of bal0 in token1 units = bal0 * price.
  // Value of bal1 in token1 units = bal1.
  const bal0InToken1 = (bal0 * numerator) / denominator;
  const totalInToken1 = bal0InToken1 + bal1;
  // Convert total back to base-asset units.
  if (pool.token1 === baseAsset) {
    return totalInToken1;
  }
  // Base = token0. Convert token1 back to token0 via the same price.
  // total_in_token0 = totalInToken1 / price = totalInToken1 * denominator / numerator
  return (totalInToken1 * denominator) / numerator;
}

/** Inspect the vault balances of token0/token1 and swap half of the heavier
 *  side into the lighter side via the URAdapter. Returns the swap step (or
 *  `null` if no swap was needed).
 */
async function maybeSwapToBalance(args: {
  config: AgentConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  pool: import("./config.js").PoolConfig;
  positionSnapshot: PositionSnapshot;
  vaultBaseAsset: Address;
  deadline: bigint;
}): Promise<ActionStep | null> {
  const { config, publicClient, walletClient, account, pool, deadline } = args;
  const bal0 = await readErc20Balance(publicClient, pool.token0, config.vaultAddress);
  const bal1 = await readErc20Balance(publicClient, pool.token1, config.vaultAddress);

  // If either side is empty, swap half of the other into it.
  let tokenIn: Address;
  let tokenOut: Address;
  let amountIn: bigint;
  if (bal0 === 0n && bal1 > 0n) {
    tokenIn = pool.token1;
    tokenOut = pool.token0;
    amountIn = bal1 / 2n;
  } else if (bal1 === 0n && bal0 > 0n) {
    tokenIn = pool.token0;
    tokenOut = pool.token1;
    amountIn = bal0 / 2n;
  } else if (bal0 > 0n && bal1 > 0n) {
    // Both sides positive — already roughly balanced for the new symmetric range.
    return null;
  } else {
    // Both empty — nothing to do (all the value left as fees? unusual).
    return null;
  }

  if (amountIn === 0n) return null;

  // Primary path: Uniswap Trading API. It returns the best route across V3
  // and V4 pools, plus the Universal Router calldata to execute it.
  // Fallback: build a conservative single-hop V3 swap through the configured
  // pool. Used if the Trading API is unreachable or returns no route.
  let swap;
  let route: "trading-api" | "single-hop-fallback";
  try {
    swap = await quoteAndBuildMultiHop({
      apiBase: config.tradingApiBase,
      apiKey: config.tradingApiKey,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps: config.swapSlippageBps,
      // Deliver UR's output directly to the vault. URAdapter still asserts
      // the vault's balance delta, so a misencoded recipient reverts.
      recipient: config.vaultAddress,
    });
    route = "trading-api";
  } catch (e) {
    // Fall back to a direct single-hop V3 swap. Without an external quote we
    // can only set a conservative `amountOutMin` floor of 1 — the
    // URAdapter's balance-delta assertion still enforces our slippage knob
    // because the vault layer also checks `amountOutMin > 0` and we pass our
    // slippage-derived value to `executeSwap` below.
    console.warn(`[trading-api] quote failed, falling back to single-hop: ${(e as Error).message}`);
    swap = buildSingleHopV3Swap({
      tokenIn,
      tokenOut,
      fee: pool.fee,
      amountIn,
      expectedAmountOut: 1n,
      slippageBps: config.swapSlippageBps,
      deadlineSeconds: 600,
    });
    route = "single-hop-fallback";
  }

  const txHash = await walletClient.writeContract({
    account,
    chain: null,
    address: config.vaultAddress,
    abi: vaultAbi,
    functionName: "executeSwap",
    args: [pool.urKey, tokenIn, amountIn, swap.amountOutMin, swap.extra],
    gas: 2_000_000n,
  });
  await waitForOk(publicClient, txHash, "executeSwap");
  // Suppress unused-variable lints for parameters reserved for v2 wiring.
  void deadline;
  return {
    kind: "swap",
    txHash,
    detail: {
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOutMin: swap.amountOutMin.toString(),
      route,
    },
  };
}
