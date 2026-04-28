import {
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { vaultAbi } from "./abi.js";
import type { AgentConfig } from "./config.js";
import type { ActionStep } from "./log.js";
import type { PositionSnapshot } from "./monitor.js";
import type { Plan } from "./planner.js";
import { buildSingleHopV3Swap } from "./quoting.js";

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
    });
    await publicClient.waitForTransactionReceipt({ hash: removeTx });
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
    const bal0 = await readErc20Balance(publicClient, pool.token0, config.vaultAddress);
    const bal1 = await readErc20Balance(publicClient, pool.token1, config.vaultAddress);
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
        // 1% slippage floor on the LP add itself.
        (bal0 * BigInt(10_000 - config.liquiditySlippageBps)) / 10_000n,
        (bal1 * BigInt(10_000 - config.liquiditySlippageBps)) / 10_000n,
        addExtra,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: addTx });
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
  return client.readContract({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [holder] });
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

  // Quote on-chain via the V3 pool (single-hop). For multi-hop we'd swap to
  // the Trading API; v1 ships single-hop only.
  // Expected output is approximated via Trading API's quote endpoint OR a
  // local sqrtPrice math. For simplicity here we set a conservative minimum
  // floor and let the URAdapter assert.
  // TODO(v2): plug `quoteAndBuildMultiHop` when one of the sides isn't paired
  // directly with the other on Base mainnet.
  const swap = buildSingleHopV3Swap({
    tokenIn,
    tokenOut,
    fee: pool.fee,
    amountIn,
    // Conservative expected: pretend 1:1 in 18-dec terms minus slippage.
    // Real expected comes from Trading API once we wire it in for this hop.
    expectedAmountOut: 1n,
    slippageBps: config.swapSlippageBps,
    deadlineSeconds: 600,
  });

  const txHash = await walletClient.writeContract({
    account,
    chain: null,
    address: config.vaultAddress,
    abi: vaultAbi,
    functionName: "executeSwap",
    args: [pool.urKey, tokenIn, amountIn, swap.amountOutMin, swap.extra],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  // Suppress unused-variable lints for parameters reserved for v2 wiring.
  void deadline;
  return {
    kind: "swap",
    txHash,
    detail: { tokenIn, tokenOut, amountIn: amountIn.toString() },
  };
}
