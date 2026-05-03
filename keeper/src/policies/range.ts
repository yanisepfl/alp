import type { PositionObservation } from "../monitor";
import type { VolatilityProfile } from "../vault";
import type { Candidate } from "./types";

const HYSTERESIS_N = 2;
const HYSTERESIS_CLOSER_FRACTION = 0.5;

interface State {
  outOfRangeStreak: number;
  firstOutDistance: number | null;
}
const state = new Map<string, State>();

function key(o: PositionObservation): string {
  return `${o.pool.lpKey.toLowerCase()}:${o.positionId.toString()}`;
}

export function run(observations: readonly PositionObservation[]): Candidate[] {
  const out: Candidate[] = [];
  for (const o of observations) {
    const k = key(o);
    const prior = state.get(k) ?? { outOfRangeStreak: 0, firstOutDistance: null };

    if (o.inRange) {
      state.set(k, { outOfRangeStreak: 0, firstOutDistance: null });
      out.push({
        priority: 10,
        decision: {
          action: "thought",
          pool: o.pool.lpKey,
          reasoning: `${o.pool.label} pos#${o.positionId} in range: tick ${o.currentTick} ∈ [${o.tickLower}, ${o.tickUpper}], fees flowing.`,
          policy: "range",
        },
      });
      continue;
    }

    if (prior.outOfRangeStreak === 0 || prior.firstOutDistance === null) {
      state.set(k, { outOfRangeStreak: 1, firstOutDistance: o.outOfRangeDistance });
      out.push({
        priority: 30,
        decision: {
          action: "thought",
          pool: o.pool.lpKey,
          reasoning: `${o.pool.label} pos#${o.positionId} drifted out of range by ${o.outOfRangeDistance} ticks; arming hysteresis (1/${HYSTERESIS_N}).`,
          policy: "range",
        },
      });
      continue;
    }

    // Drift returning toward range: defer rather than burn gas on a
    // rebalance that was about to be unnecessary.
    const closerThreshold = prior.firstOutDistance * HYSTERESIS_CLOSER_FRACTION;
    if (o.outOfRangeDistance < closerThreshold) {
      state.set(k, prior);
      out.push({
        priority: 30,
        decision: {
          action: "thought",
          pool: o.pool.lpKey,
          reasoning: `${o.pool.label} pos#${o.positionId} drift shrunk ${prior.firstOutDistance}→${o.outOfRangeDistance} ticks; price returning, holding rebalance.`,
          policy: "range",
        },
      });
      continue;
    }

    if (prior.outOfRangeStreak + 1 >= HYSTERESIS_N) {
      const { lower, upper } = computeNewRange(o.pool.profile, o.pool.tickSpacing, o.currentTick);
      state.set(k, { outOfRangeStreak: 0, firstOutDistance: null });
      out.push({
        priority: 70,
        decision: {
          action: "rebalance",
          pool: o.pool.lpKey,
          payload: { newRange: { lower, upper } },
          reasoning: `${o.pool.label} pos#${o.positionId} out of range for ${prior.outOfRangeStreak + 1} consecutive obs; recentering [${lower}, ${upper}] around tick ${o.currentTick}.`,
          policy: "range",
        },
      });
      continue;
    }

    state.set(k, { outOfRangeStreak: prior.outOfRangeStreak + 1, firstOutDistance: prior.firstOutDistance });
    out.push({
      priority: 30,
      decision: {
        action: "thought",
        pool: o.pool.lpKey,
        reasoning: `${o.pool.label} pos#${o.positionId} streak ${prior.outOfRangeStreak + 1}/${HYSTERESIS_N}, holding.`,
        policy: "range",
      },
    });
  }
  return out;
}

/** Re-center on current tick using the pool's configured profile width.
 *  Used when /force?pool=<key> targets a pool that the policies didn't
 *  flag for rebalance — synthesizes a Decision so the actuation pipeline
 *  still fires, and uses the same width formula as a natural rebalance so
 *  the forced position lands at the configured tightness. */
export function forceSynthesisCandidate(o: PositionObservation): Candidate {
  const { lower, upper } = computeNewRange(o.pool.profile, o.pool.tickSpacing, o.currentTick);
  return {
    priority: 999,
    decision: {
      action: "rebalance",
      pool: o.pool.lpKey,
      payload: { newRange: { lower, upper } },
      reasoning: `forced rebalance on ${o.pool.label} pos#${o.positionId}: recentering [${lower}, ${upper}] around tick ${o.currentTick} at profile width (was [${o.tickLower}, ${o.tickUpper}]).`,
      policy: "range",
    },
  };
}

function widthForProfile(p: VolatilityProfile): { kind: "ticks"; halfWidthTicks: number } | { kind: "pct"; halfWidthPct: number } {
  switch (p) {
    case "stable": return { kind: "ticks", halfWidthTicks: 2 };
    case "low":    return { kind: "pct", halfWidthPct: 0.01 };
    case "mid":    return { kind: "pct", halfWidthPct: 0.05 };
    case "high":   return { kind: "pct", halfWidthPct: 0.10 };
  }
}

export function computeNewRange(profile: VolatilityProfile, tickSpacing: number, currentTick: number): { lower: number; upper: number } {
  const w = widthForProfile(profile);
  const halfTicks = w.kind === "ticks"
    ? w.halfWidthTicks
    : Math.floor(Math.log(1 + w.halfWidthPct) / Math.log(1.0001));
  const roundedHalf = Math.ceil(halfTicks / tickSpacing) * tickSpacing;
  const centre = Math.round(currentTick / tickSpacing) * tickSpacing;
  return { lower: centre - roundedHalf, upper: centre + roundedHalf };
}
