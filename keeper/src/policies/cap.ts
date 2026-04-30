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

  // Build a single composite thought with per-pool headroom — easier to
  // narrate than N separate thoughts when only one is interesting. Each
  // pool's read is independently try/catched so one bad adapter doesn't
  // suppress the rest of the narration.
  const lines: string[] = [];
  let maxBreachBps = 0;
  for (const p of pools) {
    let value: bigint | null = null;
    try {
      value = await readPoolValueExternal(p.lpKey);
    } catch (e) {
      lines.push(`${p.label}: poolValueExternal read failed (${(e as Error).message.slice(0, 40)}); cap ${(p.maxAllocationBps / 100).toFixed(2)}%.`);
      continue;
    }
    const capPct = (p.maxAllocationBps / 100).toFixed(2);
    if (value === 0n) {
      // Adapter returned zero. Could be legitimate (position drained) or
      // a pricing-side gap (V4 native-ETH valued at 0). Surface the gap
      // qualitatively rather than asserting "0% of TAV".
      lines.push(`${p.label}: poolValueExternal returned 0 (likely V4/native-ETH pricing gap); cap ${capPct}%, qualitative tracking.`);
      continue;
    }
    const shareBps = Number((value * 10000n) / tav);
    const headroomBps = p.maxAllocationBps - shareBps;
    const headroomPp = (headroomBps / 100).toFixed(2);
    const sharePct = (shareBps / 100).toFixed(2);
    if (headroomBps < 0) {
      maxBreachBps = Math.max(maxBreachBps, -headroomBps);
      lines.push(`${p.label}: ${sharePct}% > cap ${capPct}% (BREACH ${(-headroomBps / 100).toFixed(2)}pp).`);
    } else {
      lines.push(`${p.label}: ${sharePct}% of TAV vs ${capPct}% cap, ${headroomPp}pp headroom.`);
    }
  }

  const verdict = maxBreachBps > 0
    ? "would redistribute the breaching pool down (deferred to v2 actuator)."
    : "all pools within cap, no action.";

  return [{
    priority: 60,
    decision: {
      action: "thought",
      reasoning: `cap: ${lines.join(" ")} ${verdict}`,
      policy: "cap",
    },
  }];
}
