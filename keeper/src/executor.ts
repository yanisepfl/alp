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
  consultations: string[];
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
    throw new Error(`executor: unsupported action '${decision.action}'`);
  }
  const newRange = decision.payload?.newRange;
  if (!newRange) throw new Error("executor: rebalance Decision missing payload.newRange");

  const lockKey = `${pool.lpKey}:${observation.positionId.toString()}`;
  if (inflight.has(lockKey)) throw new Error(`position ${lockKey} already has an in-flight rebalance`);
  inflight.add(lockKey);

  try {
    const consultations: string[] = [];
    const consult = await consultLiquidityApi(pool, observation, newRange);
    consultations.push(...consult.lines);

    if (DRY_RUN) {
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

async function consultLiquidityApi(
  pool: TrackedPool,
  observation: PositionObservation,
  newRange: { lower: number; upper: number },
): Promise<{
  lines: string[];
  decrease: LiquidityApiResult<ConsultationResponse>;
  create: LiquidityApiResult<ConsultationResponse>;
}> {
  const decrease = await consultDecrease({
    pool,
    tickLower: observation.tickLower,
    tickUpper: observation.tickUpper,
    liquidity: observation.liquidity,
  });
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

  const preIdle0 = await readErc20Balance(pool.token0, env.VAULT_ADDRESS as Address);
  const preIdle1 = await readErc20Balance(pool.token1, env.VAULT_ADDRESS as Address);

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

  let bal0 = preIdle0 + removeAmounts.amount0Out;
  let bal1 = preIdle1 + removeAmounts.amount1Out;

  const swapStep = await maybeSwapToBalance({
    pool,
    amount0Out: removeAmounts.amount0Out,
    amount1Out: removeAmounts.amount1Out,
    bal0,
    bal1,
  });
  if (swapStep) {
    steps.push(swapStep.step);
    bal0 = swapStep.newBal0;
    bal1 = swapStep.newBal1;
  } else {
    steps.push({
      kind: "skipped",
      txHash: removeTx,
      detail: {
        reason: "balanced — V3 mint refunds excess",
        amount0Out: removeAmounts.amount0Out.toString(),
        amount1Out: removeAmounts.amount1Out.toString(),
      },
    });
  }

  // V4 mints with exact-input semantics; pre-compute liquidity locally.
  if (pool.kind === "v4") {
    const sqrtPriceX96 = await readV4SqrtPriceX96(pool);
    const sqrtLower = getSqrtRatioAtTick(newRange.lower);
    const sqrtUpper = getSqrtRatioAtTick(newRange.upper);
    const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, bal0, bal1);
    if (liquidity < 1000n) {
      steps.push({
        kind: "skipped",
        txHash: removeTx,
        detail: { reason: `V4 liquidity ${liquidity.toString()} below safe threshold` },
      });
      return { txHash: steps[steps.length - 1]!.txHash, dryRun: false, steps };
    }
    const sized = getAmountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity);
    bal0 = sized.amount0 < bal0 ? sized.amount0 : bal0;
    bal1 = sized.amount1 < bal1 ? sized.amount1 : bal1;
  }

  const addExtra = encodeAbiParameters(
    [{ type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint256" }],
    [newRange.lower, newRange.upper, deadline, 0n],
  );
  const addReceipt = await sendVaultCallReceipt({
    functionName: "executeAddLiquidity",
    args: [pool.lpKey, bal0, bal1, 0n, 0n, addExtra],
    label: "executeAddLiquidity",
    gas: 3_000_000n,
    skipSimulation: true,
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
}): Promise<{ step: ExecutionResult["steps"][number]; newBal0: bigint; newBal1: bigint; blockNumber: bigint } | null> {
  const { pool, amount0Out, amount1Out, bal0, bal1 } = args;

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

  // Swaps route via the URAdapter pool key, separate from the LP key.
  const swapReceipt = await sendVaultCallReceipt({
    functionName: "executeSwap",
    args: [pool.urKey, tokenIn, amountIn, amountOutMin, extra],
    label: "executeSwap",
    gas: 2_000_000n,
    skipSimulation: true,
  });
  const swapped = parseSwapped(swapReceipt.logs, pool.urKey);
  const realAmountOut = swapped?.amountOut ?? amountOutMin;
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
  skipSimulation?: boolean;
}): Promise<{ transactionHash: `0x${string}`; blockNumber: bigint; logs: readonly ReceiptLog[] }> {
  if (!args.skipSimulation) {
    await publicClient.simulateContract({
      address: env.VAULT_ADDRESS as Address,
      abi: vaultAbi,
      functionName: args.functionName,
      args: args.args as never,
      account: account.address,
    });
  }
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
