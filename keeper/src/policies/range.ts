// Range policy. Ports Yanis's hysteresis from ~/alp/agent/src/planner.ts:
// require N consecutive out-of-range observations before firing, defer if
// price is returning toward range. State (the streak counter and the
// first-out distance) is held in a per-position in-memory Map keyed by
// "<lpKey>:<positionId>" — the keeper process is long-lived, so a Map is
// sufficient at hackathon scale; restart resets the streak which is the
// safe direction (treat the first observation post-boot as a "first out").
//
// v0 (DRY_RUN gate) emits hold/wait — never rebalance — until Phase 2b
// flips DRY_RUN off. The Candidate shape is correct either way.

import { V0_MODE } from "../env";
import type { PositionObservation } from "../monitor";
import type { VolatilityProfile } from "../vault";
import type { Action, Candidate } from "./types";

const HYSTERESIS_N = 2;
const HYSTERESIS_CLOSER_FRACTION = 0.5;

// v0 narrates the range policy's per-position verdicts as "hold" so the
// /scan response satisfies the "all action=hold" smoke criterion. 2b
// switches them back to "thought" (priority 10) so range stays in the
// agent feed even when in-range, alongside idle/cap/vol commentary.
const NON_ACTUATING_KIND: Action = V0_MODE ? "hold" : "thought";

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
      // In-range: clear any streak and emit a low-priority "thought" so the
      // agent feed sees the policy's reasoning even when nothing's wrong.
      // Reasoning text quotes live tick + bounds → real signal, not vibes.
      state.set(k, { outOfRangeStreak: 0, firstOutDistance: null });
      out.push({
        priority: 10,
        decision: {
          action: NON_ACTUATING_KIND,
          pool: o.pool.lpKey,
          reasoning: `${o.pool.label} pos#${o.positionId} in range: tick ${o.currentTick} ∈ [${o.tickLower}, ${o.tickUpper}], fees flowing.`,
          policy: "range",
        },
      });
      continue;
    }

    // First out-of-range observation in this streak: arm the counter, emit
    // a "wait" thought so the user/Sherpa sees we noticed the drift but
    // haven't acted yet.
    if (prior.outOfRangeStreak === 0 || prior.firstOutDistance === null) {
      state.set(k, { outOfRangeStreak: 1, firstOutDistance: o.outOfRangeDistance });
      out.push({
        priority: 30,
        decision: {
          action: NON_ACTUATING_KIND,
          pool: o.pool.lpKey,
          reasoning: `${o.pool.label} pos#${o.positionId} drifted out of range by ${o.outOfRangeDistance} ticks; arming hysteresis (1/${HYSTERESIS_N}), watching next tick.`,
          policy: "range",
        },
      });
      continue;
    }

    // Subsequent observation: did we get meaningfully closer to range? If so
    // defer — price is returning and the rebalance was about to be wasted.
    const closerThreshold = prior.firstOutDistance * HYSTERESIS_CLOSER_FRACTION;
    if (o.outOfRangeDistance < closerThreshold) {
      state.set(k, prior);
      out.push({
        priority: 30,
        decision: {
          action: NON_ACTUATING_KIND,
          pool: o.pool.lpKey,
          reasoning: `${o.pool.label} pos#${o.positionId} drift shrunk ${prior.firstOutDistance}→${o.outOfRangeDistance} ticks; price returning, holding rebalance.`,
          policy: "range",
        },
      });
      continue;
    }

    // Hysteresis cleared: emit a real rebalance Candidate.
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

    // Streak hasn't hit N yet (defensive — N is currently 2 so this branch
    // is unreachable, but kept for when HYSTERESIS_N is raised).
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

// Force-recenter helper used by /force when no actuator targets the
// requested pool. Per Carl's 2b spec: re-center on current tick using
// the *existing* position width (NOT the profile-based width that
// `computeNewRange` would derive). This makes /force?pool=<addr> the
// reliable demo-firing path for in-range positions.
export function forceSynthesisCandidate(o: PositionObservation): Candidate {
  const halfWidth = Math.max(o.pool.tickSpacing, Math.floor((o.tickUpper - o.tickLower) / 2));
  const roundedHalf = Math.ceil(halfWidth / o.pool.tickSpacing) * o.pool.tickSpacing;
  const centre = Math.round(o.currentTick / o.pool.tickSpacing) * o.pool.tickSpacing;
  const lower = centre - roundedHalf;
  const upper = centre + roundedHalf;
  return {
    priority: 999,
    decision: {
      action: "rebalance",
      pool: o.pool.lpKey,
      payload: { newRange: { lower, upper } },
      reasoning: `forced rebalance on ${o.pool.label} pos#${o.positionId}: recentering [${lower}, ${upper}] around tick ${o.currentTick} (width preserved from prior [${o.tickLower}, ${o.tickUpper}]).`,
      policy: "range",
    },
  };
}

function widthForProfile(p: VolatilityProfile): { kind: "ticks"; halfWidthTicks: number } | { kind: "pct"; halfWidthPct: number } {
  switch (p) {
    case "stable": return { kind: "ticks", halfWidthTicks: 2 };
    case "low":    return { kind: "pct", halfWidthPct: 0.05 };
    case "mid":    return { kind: "pct", halfWidthPct: 0.10 };
    case "high":   return { kind: "pct", halfWidthPct: 0.20 };
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
