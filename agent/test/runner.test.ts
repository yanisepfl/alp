import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";

import type { AgentConfig, PoolConfig } from "../src/config.js";
import { MemoryActivityStore } from "../src/log.js";
import type { PositionSnapshot } from "../src/monitor.js";
import { freshHysteresis, planAll, positionKey, type PositionHysteresis } from "../src/planner.js";

/** Tests that exercise the planner pieces of the runner contract, without
 *  touching viem clients or external services. The runner itself is exercised
 *  end-to-end in the live mainnet smoke test (next branch).
 */
const ANY_KEY = keccak256(toHex("test"));

const POOL: PoolConfig = {
  label: "USDC/WETH 0.05%",
  lpKey: ANY_KEY,
  urKey: ANY_KEY,
  token0: "0x0000000000000000000000000000000000000001",
  token1: "0x0000000000000000000000000000000000000002",
  decimals0: 6,
  decimals1: 18,
  fee: 500,
  tickSpacing: 10,
  profile: "mid",
};

const CONFIG: AgentConfig = {
  rpcUrl: "",
  vaultAddress: "0x0",
  registryAddress: "0x0",
  v3AdapterAddress: "0x0",
  urAdapterAddress: "0x0",
  agentPrivateKey: "0x0",
  swapSlippageBps: 50,
  liquiditySlippageBps: 100,
  hysteresisN: 2,
  hysteresisCloserFraction: 0.5,
  tradingApiBase: "https://example.invalid",
  pools: [POOL],
};

function snap(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    pool: POOL,
    positionId: 1n,
    tickLower: 100,
    tickUpper: 200,
    liquidity: 1_000_000n,
    currentTick: 150,
    inRange: true,
    outOfRangeDistance: 0,
    ...overrides,
  };
}

/** Reproduces the force-override that runner.runTick applies — the same
 *  control-flow path that `/force-rebalance` triggers. We test it here in
 *  isolation so we don't need a viem mock.
 */
function applyForce(snapshots: PositionSnapshot[], force: { positionKey?: string }) {
  const prior = new Map<string, PositionHysteresis>(snapshots.map((s) => [positionKey(s), freshHysteresis(s)]));
  const plans = planAll(CONFIG, snapshots, prior);
  return plans.map((p) => {
    if (force.positionKey && positionKey(p.position) !== force.positionKey) return p;
    return {
      ...p,
      action: { kind: "rebalance" as const, reason: "forced", newTickLower: 0, newTickUpper: 0 },
    };
  });
}

describe("runner force-rebalance", () => {
  it("force=true converts an in-range position's plan into rebalance", () => {
    const inRange = snap();
    const forced = applyForce([inRange], {});
    expect(forced[0]?.action.kind).toBe("rebalance");
  });

  it("force=true with positionKey only forces the named position", () => {
    const a = snap({ positionId: 1n });
    const b = snap({ positionId: 2n });
    const forced = applyForce([a, b], { positionKey: positionKey(a) });
    expect(forced[0]?.action.kind).toBe("rebalance");
    expect(forced[1]?.action.kind).toBe("hold"); // untouched
  });
});

describe("activity log", () => {
  it("MemoryActivityStore round-trips rows", async () => {
    const store = new MemoryActivityStore();
    await store.append({
      ts: 1,
      positionKey: "k",
      pool: "USDC/WETH",
      currentTick: 0,
      range: [-10, 10],
      inRange: true,
      outOfRangeStreak: 0,
      action: "hold",
      reason: "in range",
    });
    const rows = await store.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("hold");
  });
});
