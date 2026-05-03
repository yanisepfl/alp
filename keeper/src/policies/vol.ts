import { appendTick, recentTicks } from "../db";
import type { PositionObservation } from "../monitor";
import type { Candidate } from "./types";

const WINDOW = 12;

export function run(observations: readonly PositionObservation[]): Candidate[] {
  if (observations.length === 0) return [];

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
