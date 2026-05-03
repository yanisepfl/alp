import * as antiwhip from "./policies/antiwhip";
import * as cap from "./policies/cap";
import * as idle from "./policies/idle";
import * as range from "./policies/range";
import * as vol from "./policies/vol";
import { ACTUATING, type Candidate, type Decision } from "./policies/types";
import { observe, type PositionObservation } from "./monitor";
import { loadPools, type TrackedPool } from "./vault";

export interface EngineResult {
  pools: TrackedPool[];
  observations: PositionObservation[];
  thoughts: Decision[];
  chosen: Decision;
  chosenContext: { pool: TrackedPool; observation: PositionObservation } | null;
}

export async function tick(opts?: { forcePool?: string; bypassAntiwhip?: boolean }): Promise<EngineResult> {
  const pools = await loadPools();
  const observations = await observe(pools);

  const candidates: Candidate[] = [
    ...range.run(observations),
    ...vol.run(observations),
    ...(await idle.run(pools)),
    ...(await cap.run(pools)),
    ...antiwhip.runPerPool(pools),
  ];

  // Force synthesis: when /force?pool=X is called and no actuating
  // Candidate already targets X, synthesize a re-center Decision so the
  // actuation pipeline still fires.
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

  // No actuator: rotate which non-actuator wins by tick (1-minute slot)
  // so the feed varies across cycles instead of always surfacing idle.
  if (!chosenCandidate) {
    const sorted = [...all].sort((a, b) => b.priority - a.priority);
    if (sorted.length > 0) {
      const idx = Math.floor(Date.now() / 60_000) % sorted.length;
      chosenCandidate = sorted[idx]!;
    }
  }

  if (!chosenCandidate) {
    return {
      thoughts: [],
      chosen: {
        action: "hold",
        reasoning: "no candidates emitted this tick.",
        policy: "anti-whipsaw",
      },
    };
  }

  const gated = antiwhip.gate(chosenCandidate, opts.bypassAntiwhip);
  const thoughts = all
    .filter((c) => c !== chosenCandidate)
    .map((c) => c.decision);
  return { thoughts, chosen: gated };
}
