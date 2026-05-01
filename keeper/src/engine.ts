// Engine: runs every policy, collects Candidates, picks the chosen one,
// applies the anti-whipsaw gate, and returns the materialized Decision
// list for /scan to actuate + narrate.
//
// Selection rule: among all Candidates, pick the highest-priority
// *actuating* one (rebalance / deploy_idle / refill_idle / redistribute).
// If none, the engine still returns the per-policy thoughts so the agent
// feed gets the brain's full reasoning.

import * as antiwhip from "./policies/antiwhip";
import * as cap from "./policies/cap";
import * as idle from "./policies/idle";
import * as range from "./policies/range";
import * as vol from "./policies/vol";
import { ACTUATING, type Candidate, type Decision } from "./policies/types";
import { V0_MODE } from "./env";
import { observe, type PositionObservation } from "./monitor";
import { loadPools, type TrackedPool } from "./vault";

export interface EngineResult {
  pools: TrackedPool[];
  observations: PositionObservation[];
  /** All non-chosen Candidates' decisions (thoughts from idle/cap/vol/range
   *  for in-range positions). Surfaces in /scan response and feeds Sherpa. */
  thoughts: Decision[];
  /** The principal decision after engine.choose + anti-whipsaw gate. May be
   *  an actuating action, or "hold" if no actuator wins / gate blocked. */
  chosen: Decision;
  /** When the chosen decision is actuating + has a `pool`, the resolved
   *  TrackedPool + PositionObservation needed by executor.execute(). null
   *  when chosen is hold/thought or pool not found. */
  chosenContext: { pool: TrackedPool; observation: PositionObservation } | null;
}

export async function tick(opts?: { forcePool?: string; bypassAntiwhip?: boolean }): Promise<EngineResult> {
  const pools = await loadPools();
  const observations = await observe(pools);

  const candidates: Candidate[] = [];
  candidates.push(...range.run(observations));
  if (!V0_MODE) {
    // Real-signal narrating policies. Each emits one or more thought
    // Candidates per tick describing what it observed (idle ratio, cap
    // headroom, realized vol). They don't actuate in v1 — output feeds
    // the agent ring + Sherpa.
    candidates.push(...vol.run(observations));
    candidates.push(...(await idle.run(pools)));
    candidates.push(...(await cap.run(pools)));
    // Per-pool cooldown emitter. Surfaces "pool X cooled until ts" in the
    // /scan response for any pool inside the anti-whipsaw window — the
    // narration is independent of what range said for that pool.
    candidates.push(...antiwhip.runPerPool(pools));
  }

  // Force synthesis: when /force?pool=X is called and no actuating
  // Candidate already targets X, build a default re-center Decision so
  // the rest of the actuation pipeline fires. /force without a pool
  // param doesn't synthesize — it just runs normal selection.
  if (opts?.forcePool) {
    const target = opts.forcePool.toLowerCase();
    const hasActuator = candidates.some(
      (c) => ACTUATING.has(c.decision.action) && c.decision.pool?.toLowerCase() === target,
    );
    if (!hasActuator) {
      const obs = observations.find((o) => o.pool.lpKey.toLowerCase() === target);
      if (obs) {
        candidates.push(range.forceSynthesisCandidate(obs));
      }
    }
  }

  const result = chooseAndGate(candidates, {
    forcePool: opts?.forcePool?.toLowerCase(),
    bypassAntiwhip: !!opts?.bypassAntiwhip,
  });

  // Resolve the actuating Decision's execution context. If the gate
  // downgraded to a hold (cooldown blocked), `chosenContext` is null —
  // the executor isn't called.
  let chosenContext: EngineResult["chosenContext"] = null;
  if (ACTUATING.has(result.chosen.action) && result.chosen.pool) {
    const targetKey = result.chosen.pool.toLowerCase();
    const pool = pools.find((p) => p.lpKey.toLowerCase() === targetKey);
    const observation = observations.find((o) => o.pool.lpKey.toLowerCase() === targetKey);
    if (pool && observation) chosenContext = { pool, observation };
  }

  return { pools, observations, ...result, chosenContext };
}

function chooseAndGate(
  all: Candidate[],
  opts: { forcePool?: string; bypassAntiwhip: boolean },
): { thoughts: Decision[]; chosen: Decision } {
  // Force mode: prefer the highest-priority actuating Candidate that
  // targets the requested pool. Falls back to global pick if none match
  // (caller asked for a pool we don't actuate on this tick).
  let chosenCandidate: Candidate | null = null;
  if (opts.forcePool) {
    const forced = all
      .filter((c) => ACTUATING.has(c.decision.action))
      .filter((c) => c.decision.pool?.toLowerCase() === opts.forcePool)
      .sort((a, b) => b.priority - a.priority)[0];
    if (forced) chosenCandidate = forced;
  }
  if (!chosenCandidate) {
    chosenCandidate = all
      .filter((c) => ACTUATING.has(c.decision.action))
      .sort((a, b) => b.priority - a.priority)[0] ?? null;
  }

  if (!chosenCandidate) {
    // No actuator emitted. Rotate which non-actuator wins by tick so the
    // feed doesn't read as "always idle" — idle's priority is the highest
    // among non-actuators, but every other policy has signal worth
    // surfacing too. Granularity: 1-minute slot, so KH's 5-min ticks land
    // on different policies across consecutive cycles. Sort by priority
    // first so the rotation walks meaningful candidates, not duplicates.
    const sorted = [...all].sort((a, b) => b.priority - a.priority);
    if (sorted.length > 0) {
      const idx = Math.floor(Date.now() / 60_000) % sorted.length;
      chosenCandidate = sorted[idx]!;
    }
  }

  if (!chosenCandidate) {
    // Truly empty (no positions, no policies firing). Surface a synthetic
    // hold so /scan still returns a coherent shape.
    return {
      thoughts: [],
      chosen: {
        action: "hold",
        reasoning: "no candidates emitted this tick (no active pools or no observations).",
        policy: "anti-whipsaw",
      },
    };
  }

  const gated = antiwhip.gate(chosenCandidate, opts.bypassAntiwhip);
  // Thoughts = everything except the chosen Candidate's source decision.
  const thoughts = all
    .filter((c) => c !== chosenCandidate)
    .map((c) => c.decision);
  return { thoughts, chosen: gated };
}
