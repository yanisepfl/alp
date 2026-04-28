import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";

import type { AgentConfig, PoolConfig } from "../src/config.js";
import type { PositionSnapshot } from "../src/monitor.js";
import { computeNewRange, freshHysteresis, planAll, positionKey, type PositionHysteresis } from "../src/planner.js";

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
  pools: [POOL],
};

describe("planner", () => {
  it("holds when in range", () => {
    const s = snap();
    const plans = planAll(CONFIG, [s], new Map());
    expect(plans[0]?.action.kind).toBe("hold");
  });

  it("waits on first out-of-range observation", () => {
    const s = snap({ currentTick: 250, inRange: false, outOfRangeDistance: 50 });
    const plans = planAll(CONFIG, [s], new Map());
    expect(plans[0]?.action.kind).toBe("wait");
    if (plans[0]?.action.kind === "wait") {
      expect(plans[0].action.nextStreak).toBe(1);
      expect(plans[0].action.nextFirstOutDistance).toBe(50);
    }
  });

  it("waits longer when distance shrinks below half on second observation", () => {
    const s = snap({ currentTick: 220, inRange: false, outOfRangeDistance: 20 });
    const prior = new Map<string, PositionHysteresis>([
      [positionKey(s), { positionKey: positionKey(s), outOfRangeStreak: 1, firstOutDistance: 50 }],
    ]);
    const plans = planAll(CONFIG, [s], prior);
    expect(plans[0]?.action.kind).toBe("wait");
    if (plans[0]?.action.kind === "wait") {
      // Streak preserved (didn't increment because price returning).
      expect(plans[0].action.nextStreak).toBe(1);
    }
  });

  it("rebalances on second observation when distance does not shrink", () => {
    const s = snap({ currentTick: 260, inRange: false, outOfRangeDistance: 60 });
    const prior = new Map<string, PositionHysteresis>([
      [positionKey(s), { positionKey: positionKey(s), outOfRangeStreak: 1, firstOutDistance: 50 }],
    ]);
    const plans = planAll(CONFIG, [s], prior);
    expect(plans[0]?.action.kind).toBe("rebalance");
    if (plans[0]?.action.kind === "rebalance") {
      expect(plans[0].action.newTickLower).toBeLessThan(plans[0].action.newTickUpper);
      expect(Math.abs(plans[0].action.newTickLower % POOL.tickSpacing)).toBe(0);
      expect(Math.abs(plans[0].action.newTickUpper % POOL.tickSpacing)).toBe(0);
    }
  });

  it("resets to fresh hysteresis after returning in range", () => {
    const s = snap();
    const fresh = freshHysteresis(s);
    expect(fresh.outOfRangeStreak).toBe(0);
    expect(fresh.firstOutDistance).toBeNull();
  });
});

describe("computeNewRange", () => {
  it("respects tickSpacing for stable profile", () => {
    const stablePool: PoolConfig = { ...POOL, profile: "stable", tickSpacing: 1 };
    const r = computeNewRange(stablePool, 0);
    expect(r.newTickLower).toBe(-8);
    expect(r.newTickUpper).toBe(8);
  });

  it("computes ±25% as ~2231 ticks rounded to spacing for mid profile", () => {
    const r = computeNewRange(POOL, 0);
    // log_{1.0001}(1.25) ≈ 2231.43
    // ceil(2231 / 10) * 10 = 2240
    expect(r.newTickUpper).toBe(2240);
    expect(r.newTickLower).toBe(-2240);
  });

  it("snaps the centre to a tickSpacing boundary", () => {
    const r = computeNewRange(POOL, 157);
    // round(157 / 10) * 10 = 160
    expect((r.newTickLower + r.newTickUpper) / 2).toBe(160);
  });
});
