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
import { decisionToSignalText, signal } from "../ingest";
import { rewrite } from "../narrator";
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

  // Always emit thoughts to the agent feed first — they reflect the
  // brain's per-tick reasoning regardless of whether we actuate.
  for (const t of result.thoughts) {
    if (t.action === "thought") {
      // Fire-and-forget; failures are logged but don't fail the scan.
      void signal(decisionToSignalText(t)).catch((e) => {
        console.warn("[scan] thought ingest failed:", (e as Error).message);
      });
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
      for (const line of exec.consultations) {
        void signal(`[uniswap-sdk] ${line}`).then((r) => {
          if (!r.ok) console.warn(`[scan] consultation ingest failed (status=${r.status}): ${r.error}`);
        });
      }
      void signal(decisionToSignalText(result.chosen)).then((r) => {
        if (!r.ok) console.warn(`[scan] raw chosen ingest failed (status=${r.status}): ${r.error}`);
      });
      // Narrator runs in the background; on success it overwrites with the
      // polished version. /scan doesn't await it. The consultations are
      // included in the recent-decisions context so the polished output
      // can quote them.
      const recentForNarrator = [
        ...result.thoughts.map(decisionToSignalText),
        ...exec.consultations.map((l) => `[uniswap-sdk] ${l}`),
        decisionToSignalText(result.chosen),
      ];
      void narrateAsync(result.chosen, recentForNarrator);
    }
    }
  } else if (result.chosen.action === "hold") {
    const consecutive = bumpHoldCounter();
    const shouldNarrate = env.SHERPA_NARRATE_HOLDS || consecutive % 5 === 0;
    if (shouldNarrate) {
      void signal(decisionToSignalText(result.chosen)).catch((e) => {
        console.warn("[scan] hold ingest failed:", (e as Error).message);
      });
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

async function narrateAsync(decision: Decision, recent: readonly string[]): Promise<void> {
  const polished = await rewrite(decision, { recentDecisions: recent });
  if (!polished) return;
  await signal(`[${decision.policy}] ${decision.action}: ${polished}`);
}
