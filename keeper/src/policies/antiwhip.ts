// Anti-whipsaw plays two roles:
//
// 1. `gate(chosen, bypass)` — applied AFTER the engine picks the highest-
//    priority Candidate. If the chosen pool has fired within
//    KEEPER_COOLDOWN_SECONDS, we downgrade the actuating Decision to a
//    hold with reasoning about the cooldown. /force bypasses this.
//
// 2. `runPerPool(pools)` — emits one Candidate per pool that's in
//    cooldown (priority 65). This makes the cooldown visible in /scan
//    responses regardless of what range/idle/cap/vol said for that
//    pool. Demo flow: fire /force on X → cooldown set → next /scan
//    narrates "anti-whipsaw: pool X cooled until {ts}" alongside the
//    other pools' normal commentary.

import { isInCooldown } from "../db";
import { env } from "../env";
import type { TrackedPool } from "../vault";
import type { Candidate, Decision } from "./types";

export function gate(chosen: Candidate, bypass: boolean): Decision {
  if (bypass) return chosen.decision;
  const pool = chosen.decision.pool;
  if (!pool) return chosen.decision;
  if (chosen.decision.action === "thought" || chosen.decision.action === "hold") {
    return chosen.decision;
  }
  const cd = isInCooldown(pool, env.KEEPER_COOLDOWN_SECONDS);
  if (!cd.blocked) return chosen.decision;
  const cooledUntilIso = cd.cooledUntil ? new Date(cd.cooledUntil).toISOString() : "(unknown)";
  return {
    action: "hold",
    pool,
    reasoning: `anti-whipsaw: pool ${shortPool(pool)} cooled until ${cooledUntilIso} after last ${cd.lastAction ?? "action"}; would-be ${chosen.decision.action} from policy ${chosen.decision.policy} blocked.`,
    policy: "anti-whipsaw",
  };
}

export function runPerPool(pools: readonly TrackedPool[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of pools) {
    const cd = isInCooldown(p.lpKey, env.KEEPER_COOLDOWN_SECONDS);
    if (!cd.blocked) continue;
    const cooledUntilIso = cd.cooledUntil ? new Date(cd.cooledUntil).toISOString() : "(unknown)";
    out.push({
      // Above cap (60), idle (50), vol (40), and range thoughts (10), so
      // when a pool is cooled the principal /scan narration is the
      // cooldown rather than an unrelated idle/cap thought. Below the
      // actuating priority (70) so a real rebalance Candidate would still
      // be picked first — the gate then downgrades it.
      priority: 65,
      decision: {
        action: "hold",
        pool: p.lpKey,
        reasoning: `anti-whipsaw: ${p.label} cooled until ${cooledUntilIso} after last ${cd.lastAction ?? "action"}; rebalance suppressed for the cooldown window.`,
        policy: "anti-whipsaw",
      },
    });
  }
  return out;
}

function shortPool(p: string): string {
  return p.length > 12 ? `${p.slice(0, 10)}…` : p;
}
