// Volatility policy. Real-signal narrating-only: each tick we record the
// per-pool current tick into pool_tick_history, then compute the
// realized tick range over the last 12 observations. That range maps to
// a recommended position width — narrated against the live position's
// configured width. v1 never actuates; v2 would advisorily widen/narrow
// on rebalance.
//
// "Warming up" is a true state: until 12 observations are accumulated,
// the policy says so explicitly rather than emitting a misleading
// recommendation.

import { appendTick, recentTicks } from "../db";
import type { PositionObservation } from "../monitor";
import type { Candidate } from "./types";

const WINDOW = 12;

export function run(observations: readonly PositionObservation[]): Candidate[] {
  if (observations.length === 0) return [];

  // De-dupe per-pool: append the current tick once even if there are
  // multiple positions in the same pool. Pool tick is global to the pool.
  const seenPools = new Set<string>();
  const lines: string[] = [];

  for (const o of observations) {
    const key = o.pool.lpKey.toLowerCase();
    if (seenPools.has(key)) continue;
    seenPools.add(key);

    appendTick(key, o.currentTick, WINDOW * 2);
    const history = recentTicks(key, WINDOW);

    if (history.length < WINDOW) {
      lines.push(`${o.pool.label}: warming up, ${history.length}/${WINDOW} tick history collected.`);
      continue;
    }

    const ticks = history.map((h) => h.tick);
    let min = ticks[0]!;
    let max = ticks[0]!;
    for (const t of ticks) {
      if (t < min) min = t;
      if (t > max) max = t;
    }
    const realized = max - min;
    // Recommended half-width = realized * 1.0 (covers the observed window
    // with no margin). Configured half-width approximated from the live
    // position bounds (assumes symmetric range around current tick).
    const liveHalfWidth = Math.round(((o.tickUpper - o.tickLower) / 2));
    const recommendedHalf = Math.max(o.pool.tickSpacing, realized);
    const drift = liveHalfWidth - recommendedHalf;
    const widthVerdict = drift > liveHalfWidth * 0.25
      ? "live width is wider than realized vol — could narrow on next rebalance to capture more fees."
      : drift < -liveHalfWidth * 0.25
        ? "live width is tighter than realized vol — would widen on next rebalance to reduce out-of-range risk."
        : "live width within tolerance of realized vol.";

    lines.push(
      `${o.pool.label}: realized tick range = ${realized} over last ${WINDOW} obs; live half-width ${liveHalfWidth} vs recommended ${recommendedHalf} → ${widthVerdict}`,
    );
  }

  if (lines.length === 0) return [];

  return [{
    priority: 40,
    decision: {
      action: "thought",
      reasoning: `vol: ${lines.join(" ")}`,
      policy: "vol",
    },
  }];
}
