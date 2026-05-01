// POST /scan — bearer-authed. One full keeper tick:
//   1. observe positions
//   2. run all policies → Candidates
//   3. choose + anti-whipsaw gate → principal Decision + thoughts
//   4. if actuating: executor.execute (DRY_RUN gate in v0), markCooldown,
//      POST /ingest/signal raw, fire narrator async (POSTs polished on
//      success).
//   5. if hold: bump consecutive-hold counter, narrate every Nth.
//   6. always: POST every thought to /ingest/signal so idle/cap/vol/range
//      narration shows up in the agent feed.
//   7. respond JSON {decisions, txs}.
//
// /scan does NOT await the narrator's polished rewrite — that's the
// "tx-first / narrate-after" rule. KH workflow nodes get a fast response
// and the polished entry supersedes the raw one in the feed shortly after.

import { Hono } from "hono";

import { bumpHoldCounter, markCooldown, resetHoldCounter, readHoldCounter } from "../db";
import { tick } from "../engine";
import { env } from "../env";
import { execute } from "../executor";
import { decisionToSignalText, signal, type WireSource } from "../ingest";
import { rewriteAction, rewriteSignal, rewriteThought } from "../narrator";
import { ACTUATING, type Decision } from "../policies/types";
import { requireBearer } from "./auth";

export const scanRouter = new Hono();

scanRouter.use("*", requireBearer);

scanRouter.post("/", async (c) => {
  const result = await runScan({});
  return c.json(result);
});

export interface ScanRunOpts {
  forcePool?: string;
  bypassAntiwhip?: boolean;
}

export interface ScanResponse {
  chosen: Decision;
  thoughts: Decision[];
  txs: string[];
  decisions: Decision[];
  meta: {
    pools: number;
    observations: number;
    actuated: boolean;
    dryRun: boolean;
    consecutiveHolds: number;
  };
}

export async function runScan(opts: ScanRunOpts): Promise<ScanResponse> {
  const result = await tick(opts);

  const txs: string[] = [];
  let actuated = false;
  let dryRun = false;

  // Always emit thoughts to the agent feed. Raw goes immediate (so
  // /scan returns fast and the feed never goes silent if Claude lags),
  // polished thought rewrite supersedes via fire-and-forget.
  const thoughtRecent = result.thoughts.map(decisionToSignalText);
  for (const t of result.thoughts) {
    if (t.action === "thought") {
      void signal(decisionToSignalText(t)).catch((e) => {
        console.warn("[scan] thought ingest failed:", (e as Error).message);
      });
      void narrateThoughtAsync(t, thoughtRecent);
    }
  }

  if (ACTUATING.has(result.chosen.action)) {
    if (!result.chosenContext) {
      // Defensive: shouldn't happen — engine.tick only routes actuating
      // chosens through chosenContext resolution. If we got here, the
      // pool wasn't observed this tick (e.g. position was burned between
      // observe and choose). Downgrade to hold rather than crash /scan.
      result.chosen = {
        action: "hold",
        pool: result.chosen.pool,
        reasoning: `${result.chosen.reasoning} — execution context unresolved (pool/position not in observations); downgraded to hold.`,
        policy: result.chosen.policy,
      };
      bumpHoldCounter();
    } else {
    let exec;
    try {
      exec = await execute({
        decision: result.chosen,
        pool: result.chosenContext.pool,
        observation: result.chosenContext.observation,
      });
    } catch (e) {
      // Surface execution failure as a hold + signal.
      const msg = (e as Error).message;
      const fallback: Decision = {
        action: "hold",
        pool: result.chosen.pool,
        reasoning: `execution failed: ${msg}; ${result.chosen.reasoning}`,
        policy: result.chosen.policy,
      };
      result.chosen = fallback;
      bumpHoldCounter();
    }
    if (exec) {
      txs.push(exec.txHash);
      actuated = true;
      dryRun = exec.dryRun;
      if (result.chosen.pool) markCooldown(result.chosen.pool, result.chosen.action, exec.txHash);
      resetHoldCounter();

      // Liquidity API consultations: one feed entry per call (decrease,
      // create). Read-side advisory; narration shows the brain
      // consulting Uniswap before the rebalance signal lands. Fired
      // first so the order in the feed is consult → raw → polished.
      // signal() resolves with {ok:false} on transport errors instead
      // of rejecting, so we await + check ok explicitly to surface
      // backend-down conditions in the keeper log.
      // Build sources for this actuation tx — frontend groups our
      // narrated entry with the indexer's kind:"action" entries by
      // tx hash so they render as one logical event.
      const actuationSources = !exec.dryRun ? [
        { kind: "basescan" as const, label: "rebalance tx", tx: exec.txHash },
        { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
      ] : undefined;
      for (const line of exec.consultations) {
        const rawConsult = `[uniswap-sdk] ${line}`;
        void signal(rawConsult, { sources: actuationSources }).then((r) => {
          if (!r.ok) console.warn(`[scan] consultation ingest failed (status=${r.status}): ${r.error}`);
        });
        // Polished signal-lane rewrite for each consultation.
        void narrateSignalAsync("uniswap-sdk", line, [
          ...result.thoughts.map(decisionToSignalText),
        ], actuationSources);
      }
      void signal(decisionToSignalText(result.chosen), { sources: actuationSources }).then((r) => {
        if (!r.ok) console.warn(`[scan] raw chosen ingest failed (status=${r.status}): ${r.error}`);
      });
      // Action-lane rewrite for the chosen actuating decision.
      const recentForAction = [
        ...result.thoughts.map(decisionToSignalText),
        ...exec.consultations.map((l) => `[uniswap-sdk] ${l}`),
        decisionToSignalText(result.chosen),
      ];
      void narrateActionAsync(result.chosen, recentForAction, actuationSources);
    }
    }
  } else if (result.chosen.action === "hold") {
    const consecutive = bumpHoldCounter();
    const shouldNarrate = env.SHERPA_NARRATE_HOLDS || consecutive % 5 === 0;
    if (shouldNarrate) {
      void signal(decisionToSignalText(result.chosen)).catch((e) => {
        console.warn("[scan] hold ingest failed:", (e as Error).message);
      });
      // Hold reasons (anti-whipsaw cooldowns, error-downgrades) are
      // signal-lane: name the integration/cause, quote any timestamps.
      void narrateSignalAsync(result.chosen.policy, result.chosen.reasoning, thoughtRecent);
    }
  }

  const decisions = [...result.thoughts, result.chosen];
  return {
    chosen: result.chosen,
    thoughts: result.thoughts,
    txs,
    decisions,
    meta: {
      pools: result.pools.length,
      observations: result.observations.length,
      actuated,
      dryRun,
      consecutiveHolds: readHoldCounter(),
    },
  };
}

async function narrateActionAsync(decision: Decision, recent: readonly string[], sources?: WireSource[]): Promise<void> {
  const polished = await rewriteAction(decision, { recentDecisions: recent });
  if (!polished) return;
  await signal(`[${decision.policy}] ${polished}`, { sources });
}

async function narrateThoughtAsync(decision: Decision, recent: readonly string[]): Promise<void> {
  const polished = await rewriteThought(decision, { recentDecisions: recent });
  if (!polished) return;
  await signal(`[${decision.policy}] ${polished}`);
}

async function narrateSignalAsync(policy: string, rawText: string, recent: readonly string[], sources?: WireSource[]): Promise<void> {
  const polished = await rewriteSignal(rawText, policy, { recentDecisions: recent });
  if (!polished) return;
  await signal(`[${policy}] ${polished}`, { sources });
}
