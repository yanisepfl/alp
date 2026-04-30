// Executor. Ports the remove → maybe-swap → add pipeline from
// ~/alp/agent/src/executor.ts onto the keeper's Decision/TrackedPool/
// PositionObservation shapes. Behind KEEPER_DRY_RUN: short-circuits to a
// synthetic 0xdead… tx hash so /scan still exercises the
// cooldown + ingest + narrator path during dev.
//
// State derivation strategy (Bug 3 fix). drpc is load-balanced; reading
// vault.balanceOf immediately after waitForTransactionReceipt can hit a
// node that hasn't yet replicated the tx's state, returning stale 0
// where the actual balance is non-zero. Instead of trusting follow-up
// reads, we:
//   1. Read pre-remove vault token balances ONCE at the top.
//   2. Submit remove, parse `LiquidityRemoved(amount0Out, amount1Out)`
//      from the receipt — these are committed and readable from the
//      same node that returned the receipt.
//   3. Decide swap by inspecting amount0Out/amount1Out only — if the
//      position came back with both sides positive, V3 mint can ratio-
//      match without a swap.
//   4. If swap fires, parse `Swapped(amountOut)` from the receipt.
//   5. Compute final (bal0, bal1) for the add as (pre_idle + delta…)
//      derived from event amounts. No follow-up balanceOf calls.
//
// Bug 1 fix: executeSwap is called against `pool.urKey` (the URAdapter
// pool key paired with each LP pool, computed deterministically at boot
// in vault.ts loadPools). Routing executeSwap through `lpKey` would
// dispatch to the LP adapter (V3/V4) and revert on `extra` decoding.

import { decodeEventLog, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

import { erc20BalanceAbi, v4PoolManagerAbi, vaultAbi, vaultEventsAbi } from "./abi";
import { account, publicClient, V4_POOL_MANAGER, V4_POOLS_SLOT, walletClient } from "./chain";
import { DRY_RUN, env } from "./env";
import { getAmountsForLiquidity, getLiquidityForAmounts, getSqrtRatioAtTick } from "./liquidityMath";
import type { PositionObservation } from "./monitor";
import type { Decision } from "./policies/types";
import { buildSingleHopV3Swap, quoteAndBuildMultiHop } from "./quoting";
import {
  consultCreate,
  consultDecrease,
  summariseConsultation,
  type ConsultationResponse,
  type LiquidityApiResult,
} from "./uniswapSdk";
import type { TrackedPool } from "./vault";

export interface ExecutionResult {
  txHash: `0x${string}`;
  dryRun: boolean;
  steps: Array<{ kind: "remove" | "swap" | "add" | "skipped"; txHash: `0x${string}`; detail?: Record<string, string> }>;
  /** Read-side Liquidity API consultation summaries. Each entry is one
   *  line suitable for ingest into the agent feed. The polished
   *  narrator quotes these alongside the actuating policy reasoning so
   *  the demo shows the brain consulting Uniswap before acting. Never
   *  blocks the rebalance — empty/error consultations still produce
   *  a TRUE narration ("API unavailable: ..."). */
  consultations: string[];
  /** Structured handles on the consultation payloads when callers want
   *  to inspect amounts/liquidity rather than just the narration text.
   *  null when the call failed. */
  decreaseConsultation?: LiquidityApiResult<ConsultationResponse>;
  createConsultation?: LiquidityApiResult<ConsultationResponse>;
}

export interface ExecuteArgs {
  decision: Decision;
  pool: TrackedPool;
  observation: PositionObservation;
}

const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

const inflight = new Set<string>();

export async function execute(args: ExecuteArgs): Promise<ExecutionResult> {
  const { decision, pool, observation } = args;

  if (decision.action !== "rebalance") {
    throw new Error(`executor: unsupported action '${decision.action}' (only rebalance wired in 2b)`);
  }
  const newRange = decision.payload?.newRange;
  if (!newRange) throw new Error("executor: rebalance Decision missing payload.newRange");

  const lockKey = `${pool.lpKey}:${observation.positionId.toString()}`;
  if (inflight.has(lockKey)) throw new Error(`position ${lockKey} already has an in-flight rebalance`);
  inflight.add(lockKey);

  try {
    // Consult the Uniswap Liquidity API regardless of DRY_RUN so the
    // narration pipeline exercises end-to-end during dev. Both calls
    // are read-only and degrade gracefully on error.
    const consultations: string[] = [];
    const consult = await consultLiquidityApi(pool, observation, newRange);
    consultations.push(...consult.lines);

    if (DRY_RUN) {
      // Recognisable synthetic hash. /scan downstream sees a non-empty txs[]
      // and runs cooldown + narrator without spending gas.
      const synthetic = ("0xdead" + Buffer.from(`${pool.lpKey}:${Date.now()}`).toString("hex").slice(0, 60).padEnd(60, "0")) as `0x${string}`;
      const txHash = synthetic.slice(0, 66) as `0x${string}`;
      return {
        txHash,
        dryRun: true,
        steps: [
          { kind: "remove", txHash, detail: { positionId: observation.positionId.toString() } },
          { kind: "skipped", txHash, detail: { reason: "DRY_RUN" } },
          { kind: "add", txHash, detail: { newTickLower: String(newRange.lower), newTickUpper: String(newRange.upper) } },
        ],
        consultations,
        decreaseConsultation: consult.decrease,
        createConsultation: consult.create,
      };
    }

    const live = await executeLive(pool, observation, newRange);
    return {
      ...live,
      consultations,
      decreaseConsultation: consult.decrease,
      createConsultation: consult.create,
    };
  } finally {
    inflight.delete(lockKey);
  }
}

/** Pre-rebalance Liquidity API consultation. Two parallel calls:
 *  /decrease for the current position (expected output amounts) and
 *  /create for the target pool + new range (optimal mint params). Both
 *  read-only; results inform narration and (in v2) amount/slippage
 *  math. Returns one summary line per call plus structured payloads
 *  for callers who want raw fields. */
async function consultLiquidityApi(
  pool: TrackedPool,
  observation: PositionObservation,
  newRange: { lower: number; upper: number },
): Promise<{
  lines: string[];
  decrease: LiquidityApiResult<ConsultationResponse>;
  create: LiquidityApiResult<ConsultationResponse>;
}> {
  // /decrease first: gives us expected (amount0, amount1) returned by
  // burning the existing position. Then feed those (× a buffer for
  // idle reserves) as the upper bound for /create — the SDK's optimal
  // split is then realistic, not derived from a 2^96 nonsense max.
  const decrease = await consultDecrease({
    pool,
    tickLower: observation.tickLower,
    tickUpper: observation.tickUpper,
    liquidity: observation.liquidity,
  });
  // Buffer multiplier of 10× covers cases where the vault has
  // significant idle of one side. SDK still picks the spot-ratio split,
  // so over-bounding only widens the explored space, never breaks the
  // result. Falls back to position size × 2 if /decrease errored.
  const a0Hint = decrease.ok && decrease.data?.amount0 ? BigInt(decrease.data.amount0) : 1n;
  const a1Hint = decrease.ok && decrease.data?.amount1 ? BigInt(decrease.data.amount1) : 1n;
  const create = await consultCreate({
    pool,
    tickLower: newRange.lower,
    tickUpper: newRange.upper,
    maxAmount0: (a0Hint > 0n ? a0Hint : 1n) * 10n,
    maxAmount1: (a1Hint > 0n ? a1Hint : 1n) * 10n,
  });

  return {
    lines: [
      summariseConsultation("decrease", decrease),
      summariseConsultation("create", create),
    ],
    decrease,
    create,
  };
}

async function executeLive(
  pool: TrackedPool,
  observation: PositionObservation,
  newRange: { lower: number; upper: number },
): Promise<Omit<ExecutionResult, "consultations">> {
  const steps: ExecutionResult["steps"] = [];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // 0. Read pre-remove vault balances. These get composed with event
  //    amounts to derive final balances without ever re-reading post-tx.
  const preIdle0 = await readErc20Balance(pool.token0, env.VAULT_ADDRESS as Address);
  const preIdle1 = await readErc20Balance(pool.token1, env.VAULT_ADDRESS as Address);

  // 1. Remove all liquidity. Encoding mirrors the V3 + V4 adapters: the
  //    `extra` field carries (deadline, collectFees) — true → adapter
  //    auto-collects fees and burns the NFT.
  const removeExtra = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }],
    [deadline, true],
  );
  const removeReceipt = await sendVaultCallReceipt({
    functionName: "executeRemoveLiquidity",
    args: [pool.lpKey, observation.positionId, observation.liquidity, 0n, 0n, removeExtra],
    label: "executeRemoveLiquidity",
    gas: 2_000_000n,
  });
  const removeTx = removeReceipt.transactionHash;
  const removeAmounts = parseLiquidityRemoved(removeReceipt.logs, pool.lpKey);
  if (!removeAmounts) {
    throw new Error(`executeRemoveLiquidity: LiquidityRemoved event not found in receipt logs (tx ${removeTx})`);
  }
  steps.push({
    kind: "remove",
    txHash: removeTx,
    detail: {
      positionId: observation.positionId.toString(),
      amount0Out: removeAmounts.amount0Out.toString(),
      amount1Out: removeAmounts.amount1Out.toString(),
    },
  });

  // 2. Decide swap based on what came back from the position. If the
  //    position was fully one-sided (e.g. 100% USDC because spot was
  //    above the upper tick prior to remove), we need to swap half of
  //    that side into the other so the new in-range mint accepts both.
  //    Both-positive case: V3 mint will use the limiting side and refund
  //    the rest — no swap required.
  let bal0 = preIdle0 + removeAmounts.amount0Out;
  let bal1 = preIdle1 + removeAmounts.amount1Out;

  const swapStep = await maybeSwapToBalance({
    pool,
    amount0Out: removeAmounts.amount0Out,
    amount1Out: removeAmounts.amount1Out,
    bal0,
    bal1,
    simulateAtBlock: removeReceipt.blockNumber,
  });
  // Track which receipt's block is the most recent committed state. The
  // add simulation pins to this so it sees post-remove (and post-swap,
  // when there was one) vault state regardless of which RPC node serves
  // the eth_call.
  let lastBlock = removeReceipt.blockNumber;
  if (swapStep) {
    steps.push(swapStep.step);
    bal0 = swapStep.newBal0;
    bal1 = swapStep.newBal1;
    lastBlock = swapStep.blockNumber;
  } else {
    steps.push({
      kind: "skipped",
      txHash: removeTx,
      detail: {
        reason: "position came back balanced (both sides positive); V3 mint will refund excess",
        amount0Out: removeAmounts.amount0Out.toString(),
        amount1Out: removeAmounts.amount1Out.toString(),
      },
    });
  }

  // 3. Cap-aware sizing — skipped when maxAllocBps == 100% (10000),
  //    which is the case for all three current pools per the cap policy
  //    output. v2 wires precise cross-pool USD valuation via spot lookups.
  if (pool.maxAllocationBps < 10_000) {
    // Placeholder: on-chain post-add cap check would revert if overshoot;
    // explicit scaling deferred until cross-pool spot pricing is live.
    void pool.maxAllocationBps;
  }

  // 4. V4-only sizing: pre-compute liquidity locally so the V4
  //    PositionManager doesn't revert with InsufficientLiquidityComputed.
  if (pool.kind === "v4") {
    const sqrtPriceX96 = await readV4SqrtPriceX96(pool);
    const sqrtLower = getSqrtRatioAtTick(newRange.lower);
    const sqrtUpper = getSqrtRatioAtTick(newRange.upper);
    const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, bal0, bal1);
    if (liquidity < 1000n) {
      steps.push({
        kind: "skipped",
        txHash: removeTx,
        detail: { reason: `computed V4 liquidity ${liquidity.toString()} below safe threshold` },
      });
      return { txHash: steps[steps.length - 1]!.txHash, dryRun: false, steps };
    }
    const sized = getAmountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity);
    bal0 = sized.amount0 < bal0 ? sized.amount0 : bal0;
    bal1 = sized.amount1 < bal1 ? sized.amount1 : bal1;
  }

  // 5. Add liquidity at the new range.
  const addExtra = encodeAbiParameters(
    [{ type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint256" }],
    [newRange.lower, newRange.upper, deadline, 0n],
  );
  const addReceipt = await sendVaultCallReceipt({
    functionName: "executeAddLiquidity",
    args: [pool.lpKey, bal0, bal1, 0n, 0n, addExtra],
    label: "executeAddLiquidity",
    gas: 3_000_000n,
    simulateAtBlock: lastBlock,
  });
  const addAmounts = parseLiquidityAdded(addReceipt.logs, pool.lpKey);
  steps.push({
    kind: "add",
    txHash: addReceipt.transactionHash,
    detail: {
      newTickLower: String(newRange.lower),
      newTickUpper: String(newRange.upper),
      bal0: bal0.toString(),
      bal1: bal1.toString(),
      ...(addAmounts ? {
        positionId: addAmounts.positionId.toString(),
        amount0Used: addAmounts.amount0Used.toString(),
        amount1Used: addAmounts.amount1Used.toString(),
      } : {}),
    },
  });

  return { txHash: addReceipt.transactionHash, dryRun: false, steps };
}

async function maybeSwapToBalance(args: {
  pool: TrackedPool;
  amount0Out: bigint;
  amount1Out: bigint;
  bal0: bigint;
  bal1: bigint;
  /** Pin swap simulation to this block so it sees the post-remove vault
   *  state regardless of which RPC node serves the eth_call (Fix B). */
  simulateAtBlock: bigint;
}): Promise<{ step: ExecutionResult["steps"][number]; newBal0: bigint; newBal1: bigint; blockNumber: bigint } | null> {
  const { pool, amount0Out, amount1Out, bal0, bal1, simulateAtBlock } = args;

  let tokenIn: Address;
  let tokenOut: Address;
  let amountIn: bigint;
  let direction: "0to1" | "1to0";
  if (amount0Out === 0n && amount1Out > 0n && bal0 === 0n) {
    tokenIn = pool.token1; tokenOut = pool.token0;
    amountIn = bal1 / 2n;
    direction = "1to0";
  } else if (amount1Out === 0n && amount0Out > 0n && bal1 === 0n) {
    tokenIn = pool.token0; tokenOut = pool.token1;
    amountIn = bal0 / 2n;
    direction = "0to1";
  } else {
    // Both sides came back positive (in-range remove) OR vault already
    // had idle of the missing side. Either way, V3 mint handles the
    // ratio mismatch via refund.
    return null;
  }
  if (amountIn === 0n) return null;

  let extra: Hex;
  let amountOutMin: bigint;
  let route: "trading-api" | "single-hop-fallback";
  try {
    const quoted = await quoteAndBuildMultiHop({
      apiBase: env.TRADING_API_BASE,
      apiKey: env.TRADING_API_KEY,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps: env.SWAP_SLIPPAGE_BPS,
      // Bug 2 fix: Trading API now requires `swapper`, separately from
      // `recipient`. Both set to the vault: vault is the executor of
      // the swap (URAdapter pulls vault funds, calls UR with payerIsUser
      // = adapter's msg.sender) and the final recipient (URAdapter
      // forwards the output back to the vault).
      swapper: env.VAULT_ADDRESS as Address,
      recipient: env.VAULT_ADDRESS as Address,
    });
    extra = quoted.extra;
    amountOutMin = quoted.amountOutMin;
    route = "trading-api";
  } catch (e) {
    console.warn(`[executor] trading-api quote failed (${(e as Error).message.slice(0, 80)}); falling back to single-hop`);
    const fallback = buildSingleHopV3Swap({
      tokenIn,
      tokenOut,
      fee: pool.fee,
      amountIn,
      expectedAmountOut: 1n,
      slippageBps: env.SWAP_SLIPPAGE_BPS,
      deadlineSeconds: 600,
    });
    extra = fallback.extra;
    amountOutMin = fallback.amountOutMin;
    route = "single-hop-fallback";
  }

  // Bug 1 fix: route swap via the URAdapter pool key (pool.urKey), NOT
  // the LP key. lpKey would dispatch to the V3/V4 adapter, which decodes
  // `extra` differently and reverts (the original DeadlineExpired
  // failure trace was UniV3Adapter mis-decoding our URAdapter `extra`).
  const swapReceipt = await sendVaultCallReceipt({
    functionName: "executeSwap",
    args: [pool.urKey, tokenIn, amountIn, amountOutMin, extra],
    label: "executeSwap",
    gas: 2_000_000n,
    simulateAtBlock,
  });
  const swapped = parseSwapped(swapReceipt.logs, pool.urKey);
  // Derive post-swap balances from the event. amountIn is exact; amountOut
  // came from the chain-reported delta.
  const realAmountOut = swapped?.amountOut ?? amountOutMin; // worst-case floor
  const newBal0 = direction === "0to1" ? bal0 - amountIn : bal0 + realAmountOut;
  const newBal1 = direction === "0to1" ? bal1 + realAmountOut : bal1 - amountIn;

  return {
    step: {
      kind: "swap",
      txHash: swapReceipt.transactionHash,
      detail: {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOutMin: amountOutMin.toString(),
        amountOut: realAmountOut.toString(),
        route,
        direction,
      },
    },
    newBal0,
    newBal1,
    blockNumber: swapReceipt.blockNumber,
  };
}

interface ReceiptLog {
  address: Address;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

function parseLiquidityRemoved(
  logs: readonly ReceiptLog[],
  expectPoolKey: `0x${string}`,
): { positionId: bigint; amount0Out: bigint; amount1Out: bigint } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== (env.VAULT_ADDRESS as string).toLowerCase()) continue;
    try {
      const dec = decodeEventLog({
        abi: vaultEventsAbi,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
        data: log.data,
      });
      if (dec.eventName === "LiquidityRemoved" && dec.args.poolKey.toLowerCase() === expectPoolKey.toLowerCase()) {
        return {
          positionId: dec.args.positionId,
          amount0Out: dec.args.amount0Out,
          amount1Out: dec.args.amount1Out,
        };
      }
    } catch { /* not one of our events */ }
  }
  return null;
}

function parseLiquidityAdded(
  logs: readonly ReceiptLog[],
  expectPoolKey: `0x${string}`,
): { positionId: bigint; amount0Used: bigint; amount1Used: bigint } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== (env.VAULT_ADDRESS as string).toLowerCase()) continue;
    try {
      const dec = decodeEventLog({
        abi: vaultEventsAbi,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
        data: log.data,
      });
      if (dec.eventName === "LiquidityAdded" && dec.args.poolKey.toLowerCase() === expectPoolKey.toLowerCase()) {
        return {
          positionId: dec.args.positionId,
          amount0Used: dec.args.amount0Used,
          amount1Used: dec.args.amount1Used,
        };
      }
    } catch { /* skip */ }
  }
  return null;
}

function parseSwapped(
  logs: readonly ReceiptLog[],
  expectPoolKey: `0x${string}`,
): { tokenIn: Address; amountIn: bigint; amountOut: bigint } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== (env.VAULT_ADDRESS as string).toLowerCase()) continue;
    try {
      const dec = decodeEventLog({
        abi: vaultEventsAbi,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
        data: log.data,
      });
      if (dec.eventName === "Swapped" && dec.args.poolKey.toLowerCase() === expectPoolKey.toLowerCase()) {
        return {
          tokenIn: dec.args.tokenIn,
          amountIn: dec.args.amountIn,
          amountOut: dec.args.amountOut,
        };
      }
    } catch { /* skip */ }
  }
  return null;
}

async function sendVaultCallReceipt(args: {
  functionName: "executeAddLiquidity" | "executeRemoveLiquidity" | "executeSwap";
  args: readonly unknown[];
  label: string;
  gas: bigint;
  /** Fix B: pin the simulation read to a specific block. State-at-
   *  block is consensus-deterministic — every node that has block N
   *  agrees on its state — so even if the RPC is load-balanced behind
   *  a slightly-behind node, eth_call at block N is correct. Used
   *  after executeRemoveLiquidity to make the swap/add simulations
   *  see the post-remove vault state regardless of which node serves
   *  the call. Pass `undefined` for first-step calls (remove); pass
   *  `previousReceipt.blockNumber` for downstream steps. */
  simulateAtBlock?: bigint;
}): Promise<{ transactionHash: `0x${string}`; blockNumber: bigint; logs: readonly ReceiptLog[] }> {
  // Simulate first so reverts surface with a useful message rather than
  // viem's generic "transaction reverted". The vault has rich custom
  // errors (e.g. CapBreached, SlippageMinRequired) that show up here.
  await publicClient.simulateContract({
    address: env.VAULT_ADDRESS as Address,
    abi: vaultAbi,
    functionName: args.functionName,
    args: args.args as never,
    account: account.address,
    ...(args.simulateAtBlock !== undefined ? { blockNumber: args.simulateAtBlock } : {}),
  });
  const hash = await walletClient.writeContract({
    address: env.VAULT_ADDRESS as Address,
    abi: vaultAbi,
    functionName: args.functionName,
    args: args.args as never,
    gas: args.gas,
    chain: walletClient.chain,
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${args.label} reverted (tx ${hash})`);
  }
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, logs: receipt.logs };
}

async function readErc20Balance(token: Address, holder: Address): Promise<bigint> {
  if (token === NATIVE_ETH) {
    return publicClient.getBalance({ address: holder });
  }
  return (await publicClient.readContract({
    address: token,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
}

async function readV4SqrtPriceX96(pool: TrackedPool): Promise<bigint> {
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" }, { type: "address" }, { type: "uint24" },
        { type: "int24" }, { type: "address" },
      ],
      [pool.token0, pool.token1, pool.fee, pool.tickSpacing, pool.hooks],
    ),
  );
  const slot0Slot = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, V4_POOLS_SLOT]),
  );
  const raw = (await publicClient.readContract({
    address: V4_POOL_MANAGER,
    abi: v4PoolManagerAbi,
    functionName: "extsload",
    args: [slot0Slot],
  })) as `0x${string}`;
  const mask160 = (1n << 160n) - 1n;
  return BigInt(raw) & mask160;
}
