// Cap-pressure policy. Real-signal narrating-only: every tick we compare
// each pool's actual share of TAV against its on-chain maxAllocationBps
// from PoolRegistry. Output is a thought Decision per pool flagging
// headroom / breach. v1 doesn't actuate — v2 would emit a redistribute
// Candidate when a pool exceeds its cap.

import type { Candidate } from "./types";
import { readPoolValueExternal, readTotalAssets, type TrackedPool } from "../vault";

export async function run(pools: readonly TrackedPool[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let tav: bigint;
  try {
    tav = await readTotalAssets();
  } catch (e) {
    return [{
      priority: 10,
      decision: {
        action: "thought",
        reasoning: `cap policy: totalAssets() failed (${(e as Error).message}); skipping.`,
        policy: "cap",
      },
    }];
  }
  if (tav === 0n) {
    return [{
      priority: 10,
      decision: {
        action: "thought",
        reasoning: "cap policy: TAV is zero; cap pressure undefined.",
        policy: "cap",
      },
    }];
  }

  // Silent unless at least one pool is approaching its cap (within 10pp)
  // or already breaching. Removes feed noise when caps are loose, and
  // surfaces specifically the pool that matters when one tightens.
  const APPROACHING_HEADROOM_BPS = 1000; // 10pp = "very close"
  const lines: string[] = [];
  let approaching = false;
  let maxBreachBps = 0;
  for (const p of pools) {
    let value: bigint | null = null;
    try {
      value = await readPoolValueExternal(p.lpKey);
    } catch {
      continue;
    }
    if (value === 0n) continue;
    const shareBps = Number((value * 10000n) / tav);
    const headroomBps = p.maxAllocationBps - shareBps;
    const sharePct = (shareBps / 100).toFixed(2);
    const capPct = (p.maxAllocationBps / 100).toFixed(2);
    if (headroomBps < 0) {
      maxBreachBps = Math.max(maxBreachBps, -headroomBps);
      lines.push(`${p.label}: ${sharePct}% > cap ${capPct}% (BREACH ${(-headroomBps / 100).toFixed(2)}pp).`);
    } else if (headroomBps < APPROACHING_HEADROOM_BPS) {
      approaching = true;
      lines.push(`${p.label}: ${sharePct}% of TAV approaching ${capPct}% cap (${(headroomBps / 100).toFixed(2)}pp headroom).`);
    }
  }

  if (!approaching && maxBreachBps === 0) return [];

  const verdict = maxBreachBps > 0
    ? "would redistribute the breaching pool down (deferred to v2 actuator)."
    : "narrowing in on its cap.";

  return [{
    priority: 60,
    decision: {
      action: "thought",
      reasoning: `cap: ${lines.join(" ")} ${verdict}`,
      policy: "cap",
    },
  }];
}
