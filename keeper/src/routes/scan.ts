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

// Accept POST (canonical) and GET (KH workflow runtime ignores our
// method=POST config and defaults to GET). Request body is {} either
// way so HTTP semantics are preserved.
const handler = async (c: any) => c.json(await runScan({}));
scanRouter.post("/", handler);
scanRouter.get("/", handler);

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

  // Emit polished-only per thought. Narrator rewrites in the background;
  // on success, the polished entry lands. On null (timeout / Claude
  // error), narrateThoughtAsync falls back to the raw decisionToSignalText
  // so the feed never goes silent. One ring entry per thought, no dupes.
  const thoughtRecent = result.thoughts.map(decisionToSignalText);
  for (const t of result.thoughts) {
    if (t.action === "thought") {
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
      // Sources let the frontend group our narrated entries with the
      // indexer's kind:"action" entries on the same tx hash.
      const actuationSources = !exec.dryRun ? [
        { kind: "basescan" as const, label: "rebalance tx", tx: exec.txHash },
        { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
      ] : undefined;
      // Polished-only emit. Narrators fall back to raw on timeout so
      // failures still produce a single entry per logical event.
      for (const line of exec.consultations) {
        void narrateSignalAsync("uniswap-sdk", line, [
          ...result.thoughts.map(decisionToSignalText),
        ], actuationSources);
      }
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
      // Hold reasons (anti-whipsaw cooldowns, error-downgrades) are
      // signal-lane: name the integration/cause, quote any timestamps.
      // Narrator falls back to raw if Claude times out.
      void narrateSignalAsync(result.chosen.policy, result.chosen.reasoning, thoughtRecent);
    }
  } else if (result.chosen.action === "thought") {
    // Non-actuating thought won the engine's pick this tick. Already
    // emitted via the thoughts loop above — don't double-narrate.
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

// Narrator helpers — each returns a polished entry on Claude success and
// falls back to the raw input on timeout/error so the feed always gets
// exactly one entry per logical event (no dupes, no silence on failure).

async function narrateActionAsync(decision: Decision, recent: readonly string[], sources?: WireSource[]): Promise<void> {
  const polished = await rewriteAction(decision, { recentDecisions: recent });
  const text = polished
    ? `[${decision.policy}] ${polished}`
    : decisionToSignalText(decision);
  await signal(text, { sources });
}

async function narrateThoughtAsync(decision: Decision, recent: readonly string[]): Promise<void> {
  const polished = await rewriteThought(decision, { recentDecisions: recent });
  const text = polished
    ? `[${decision.policy}] ${polished}`
    : decisionToSignalText(decision);
  await signal(text);
}

async function narrateSignalAsync(policy: string, rawText: string, recent: readonly string[], sources?: WireSource[]): Promise<void> {
  const polished = await rewriteSignal(rawText, policy, { recentDecisions: recent });
  const text = polished
    ? `[${policy}] ${polished}`
    : `[${policy}] ${rawText}`;
  await signal(text, { sources });
}
