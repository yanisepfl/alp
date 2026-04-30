// Types shared across policies and the engine.
//
// A policy emits zero or more Candidates per tick. The engine merges them,
// picks the highest-priority *actuating* one, and gates it on anti-whipsaw.
// Non-actuating Candidates (action="thought" / "hold") still surface in
// the response and feed Sherpa.

export type ActuatingAction = "rebalance" | "deploy_idle" | "refill_idle" | "redistribute";
export type NonActuatingAction = "thought" | "hold";
export type Action = ActuatingAction | NonActuatingAction;

export const ACTUATING: ReadonlySet<Action> = new Set<Action>([
  "rebalance", "deploy_idle", "refill_idle", "redistribute",
]);

export type PolicyName = "range" | "idle" | "cap" | "vol" | "anti-whipsaw";

export interface Decision {
  action: Action;
  pool?: string;
  payload?: {
    newRange?: { lower: number; upper: number };
    swap?: { from: string; to: string; amount: string };
  };
  reasoning: string;
  policy: PolicyName;
}

export interface Candidate {
  /** Higher wins. Defaults: range=70, cap=60, idle=50, vol=40, thoughts=10. */
  priority: number;
  decision: Decision;
}
