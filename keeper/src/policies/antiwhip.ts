import { isInCooldown } from "../db";
import { env } from "../env";
import type { TrackedPool } from "../vault";
import type { Candidate, Decision } from "./types";

/** Applied after the engine picks. If the chosen pool fired within
 *  KEEPER_COOLDOWN_SECONDS, downgrade to hold. /force bypasses. */
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

/** Emit one hold Candidate per pool currently in cooldown so the
 *  cooldown is visible in the /scan response alongside other policies. */
export function runPerPool(pools: readonly TrackedPool[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of pools) {
    const cd = isInCooldown(p.lpKey, env.KEEPER_COOLDOWN_SECONDS);
    if (!cd.blocked) continue;
    const cooledUntilIso = cd.cooledUntil ? new Date(cd.cooledUntil).toISOString() : "(unknown)";
    out.push({
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
