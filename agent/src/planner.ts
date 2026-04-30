import type { AgentConfig, PoolConfig } from "./config.js";
import { widthForProfile } from "./config.js";
import type { PositionSnapshot } from "./monitor.js";

/** Persisted state for a single position across agent ticks. */
export interface PositionHysteresis {
  positionKey: string;
  /** Number of consecutive observations the position has been out-of-range. */
  outOfRangeStreak: number;
  /** Tick distance at the first out-of-range observation in the current streak. */
  firstOutDistance: number | null;
}

export type PlanAction =
  | { kind: "hold"; reason: string }
  | { kind: "wait"; reason: string; nextStreak: number; nextFirstOutDistance: number }
  | {
      kind: "rebalance";
      reason: string;
      newTickLower: number;
      newTickUpper: number;
    };

export interface Plan {
  position: PositionSnapshot;
  prior: PositionHysteresis;
  action: PlanAction;
}

/** Decide what to do with each position based on its current snapshot and
 *  the agent's prior hysteresis state. Pure function — caller persists the
 *  resulting state and acts on the rebalance plans.
 */
export function planAll(
  config: AgentConfig,
  snapshots: PositionSnapshot[],
  priorState: Map<string, PositionHysteresis>,
): Plan[] {
  return snapshots.map((s) => planOne(config, s, priorState.get(positionKey(s)) ?? freshHysteresis(s)));
}

export function positionKey(s: PositionSnapshot): string {
  return `${s.pool.lpKey}:${s.positionId.toString()}`;
}

export function freshHysteresis(s: PositionSnapshot): PositionHysteresis {
  return { positionKey: positionKey(s), outOfRangeStreak: 0, firstOutDistance: null };
}

function planOne(config: AgentConfig, s: PositionSnapshot, prior: PositionHysteresis): Plan {
  if (s.inRange) {
    return { position: s, prior, action: { kind: "hold", reason: "in range, fees flowing" } };
  }

  // First out-of-range observation in this streak: arm the counter.
  if (prior.outOfRangeStreak === 0 || prior.firstOutDistance === null) {
    return {
      position: s,
      prior,
      action: {
        kind: "wait",
        reason: "first out-of-range observation; waiting for confirmation",
        nextStreak: 1,
        nextFirstOutDistance: s.outOfRangeDistance,
      },
    };
  }

  // Subsequent observation: did we get meaningfully closer to range?
  const closerThreshold = prior.firstOutDistance * config.hysteresisCloserFraction;
  if (s.outOfRangeDistance < closerThreshold) {
    return {
      position: s,
      prior,
      action: {
        kind: "wait",
        reason: `distance shrunk from ${prior.firstOutDistance} to ${s.outOfRangeDistance} ticks; price returning, waiting another tick`,
        nextStreak: prior.outOfRangeStreak,
        nextFirstOutDistance: prior.firstOutDistance,
      },
    };
  }

  // Hysteresis cleared: rebalance.
  if (prior.outOfRangeStreak + 1 >= config.hysteresisN) {
    const { newTickLower, newTickUpper } = computeNewRange(s.pool, s.currentTick);
    return {
      position: s,
      prior,
      action: {
        kind: "rebalance",
        reason: `out-of-range for ${prior.outOfRangeStreak + 1} consecutive obs; recentering [${newTickLower}, ${newTickUpper}] around tick ${s.currentTick}`,
        newTickLower,
        newTickUpper,
      },
    };
  }

  // Streak hasn't hit N yet (in case operator increased N at runtime).
  return {
    position: s,
    prior,
    action: {
      kind: "wait",
      reason: `streak ${prior.outOfRangeStreak + 1} < N=${config.hysteresisN}`,
      nextStreak: prior.outOfRangeStreak + 1,
      nextFirstOutDistance: prior.firstOutDistance,
    },
  };
}

/** Compute the new tick range for a rebalance, centred on `currentTick` and
 *  rounded to the pool's tick spacing.
 */
export function computeNewRange(pool: PoolConfig, currentTick: number): { newTickLower: number; newTickUpper: number } {
  const w = widthForProfile(pool.profile);
  let halfTicks: number;
  if (w.kind === "ticks") {
    halfTicks = w.halfWidthTicks;
  } else {
    // ±pct in price space → ticks: tick offset = log_{1.0001}(1 + pct).
    halfTicks = Math.floor(Math.log(1 + w.halfWidthPct) / Math.log(1.0001));
  }
  const spacing = pool.tickSpacing;
  // Round half-width to a multiple of spacing (round up so the band is at
  // least the requested width).
  const roundedHalf = Math.ceil(halfTicks / spacing) * spacing;
  // Snap centre to the nearest spacing boundary so the resulting bounds are
  // also valid spacing multiples.
  const centre = Math.round(currentTick / spacing) * spacing;
  return { newTickLower: centre - roundedHalf, newTickUpper: centre + roundedHalf };
}
