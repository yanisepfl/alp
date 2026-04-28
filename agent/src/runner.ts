import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { vaultAbi } from "./abi.js";
import type { AgentConfig } from "./config.js";
import { executeRebalance } from "./executor.js";
import { type ActivityStore, planToActivityRow } from "./log.js";
import { snapshotPositions } from "./monitor.js";
import { freshHysteresis, planAll, positionKey, type PositionHysteresis } from "./planner.js";

export interface TickResult {
  observedPositions: number;
  rebalances: number;
  errors: string[];
}

/** One full agent tick: snapshot, plan, execute, log. */
export async function runTick(args: {
  config: AgentConfig;
  store: ActivityStore;
  loadHysteresis: () => Promise<Map<string, PositionHysteresis>>;
  saveHysteresis: (state: Map<string, PositionHysteresis>) => Promise<void>;
}): Promise<TickResult> {
  const { config, store, loadHysteresis, saveHysteresis } = args;

  const account = privateKeyToAccount(config.agentPrivateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) }) as PublicClient;
  const walletClient = createWalletClient({ chain: base, transport: http(config.rpcUrl) }) as WalletClient;

  const vaultBaseAsset = (await publicClient.readContract({
    address: config.vaultAddress,
    abi: vaultAbi,
    functionName: "asset",
  })) as Address;

  const snapshots = await snapshotPositions(publicClient, config);
  const prior = await loadHysteresis();
  const plans = planAll(config, snapshots, prior);

  const errors: string[] = [];
  let rebalances = 0;
  const next = new Map<string, PositionHysteresis>();

  for (const plan of plans) {
    const key = positionKey(plan.position);
    if (plan.action.kind === "hold") {
      next.set(key, freshHysteresis(plan.position));
      await store.append(planToActivityRow(plan));
      continue;
    }
    if (plan.action.kind === "wait") {
      next.set(key, {
        positionKey: key,
        outOfRangeStreak: plan.action.nextStreak,
        firstOutDistance: plan.action.nextFirstOutDistance,
      });
      await store.append(planToActivityRow(plan));
      continue;
    }
    // Rebalance.
    try {
      const steps = await executeRebalance({
        config,
        publicClient,
        walletClient,
        account: account.address,
        plan,
        vaultBaseAsset,
      });
      next.set(key, freshHysteresis(plan.position));
      await store.append(planToActivityRow(plan, steps));
      rebalances++;
    } catch (e) {
      errors.push(`${key}: ${(e as Error).message}`);
      // Keep the streak so we can try again next tick.
      next.set(key, prior.get(key) ?? freshHysteresis(plan.position));
      await store.append({
        ...planToActivityRow(plan),
        reason: `${plan.action.reason} — execution failed: ${(e as Error).message}`,
      });
    }
  }

  await saveHysteresis(next);

  return { observedPositions: snapshots.length, rebalances, errors };
}
