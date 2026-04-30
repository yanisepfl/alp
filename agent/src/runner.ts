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
import { KeeperHubClient } from "./keeperhub.js";
import { type ActivityStore, planToActivityRow } from "./log.js";
import { snapshotPositions } from "./monitor.js";
import {
  computeNewRange,
  freshHysteresis,
  planAll,
  positionKey,
  type Plan,
  type PositionHysteresis,
} from "./planner.js";
import { KeeperHubSender, type TxSender } from "./sender.js";

export interface TickResult {
  observedPositions: number;
  rebalances: number;
  errors: string[];
  /** Populated when `dryRun = true`: the action plan the agent would have
   *  executed. Useful for live verification without spending gas. */
  plans?: Array<{ positionKey: string; pool: string; action: string; reason: string }>;
}

/** Optional override for /trigger and /force-rebalance.
 *
 *  - `force = true` ignores hysteresis and treats every position (or just
 *    `positionKey` if set) as if it needed a rebalance, recentering the range
 *    around the current spot. Used by the demo "rebalance now" button.
 *  - `dryRun = true` skips on-chain submission entirely and returns the plan
 *    list. Used to verify the agent reads chain state correctly without
 *    spending money.
 */
export interface RunOptions {
  force?: boolean;
  /** If set with `force`, only this position is rebalanced. Otherwise all. */
  positionKey?: string;
  dryRun?: boolean;
}

/** One full agent tick: snapshot, plan, execute, log. */
export async function runTick(args: {
  config: AgentConfig;
  store: ActivityStore;
  loadHysteresis: () => Promise<Map<string, PositionHysteresis>>;
  saveHysteresis: (state: Map<string, PositionHysteresis>) => Promise<void>;
  options?: RunOptions;
}): Promise<TickResult> {
  const { config, store, loadHysteresis, saveHysteresis, options = {} } = args;

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
  let plans = planAll(config, snapshots, prior);

  // Force overrides: replace the planner's verdict with an unconditional
  // rebalance for the targeted position(s). Hysteresis state is not consulted
  // and not advanced (the position is reset to fresh on success).
  if (options.force) {
    plans = plans.map((p): Plan => {
      if (options.positionKey && positionKey(p.position) !== options.positionKey) return p;
      const { newTickLower, newTickUpper } = computeNewRange(p.position.pool, p.position.currentTick);
      return {
        position: p.position,
        prior: p.prior,
        action: {
          kind: "rebalance",
          reason: `forced rebalance${options.positionKey ? ` for ${options.positionKey}` : " (all positions)"}`,
          newTickLower,
          newTickUpper,
        },
      };
    });
  }

  if (options.dryRun) {
    return {
      observedPositions: snapshots.length,
      rebalances: 0,
      errors: [],
      plans: plans.map((p) => ({
        positionKey: positionKey(p.position),
        pool: p.position.pool.label,
        action: p.action.kind,
        reason: p.action.reason,
      })),
    };
  }

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
    // Rebalance. Pick the tx sender once per tick so logs are consistent.
    let sender: TxSender | undefined;
    if (config.keeperHubDirectExec && config.keeperHubApiKey) {
      sender = new KeeperHubSender(new KeeperHubClient({ apiKey: config.keeperHubApiKey, network: "base" }));
    }
    try {
      const steps = await executeRebalance({
        config,
        publicClient,
        walletClient,
        account: account.address,
        plan,
        vaultBaseAsset,
        sender,
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
