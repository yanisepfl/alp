import { Hono } from "hono";

import { bumpHoldCounter, markCooldown, resetHoldCounter, readHoldCounter, recentRingTexts } from "../db";
import { tick } from "../engine";
import { execute } from "../executor";
import { decisionToSignalText, signal, type WireSource } from "../ingest";
import { rewriteAction, rollupTick } from "../narrator";
import { ACTUATING, type Decision } from "../policies/types";
import { readTotalAssets } from "../vault";
import { requireBearer } from "./auth";

export const scanRouter = new Hono();
scanRouter.use("*", requireBearer);

scanRouter.post("/", async (c) => {
  let body: { context?: KhContext } = {};
  try { body = await c.req.json(); } catch { /* empty body fine */ }
  return c.json(await runScan({ khContext: body.context }));
});
scanRouter.get("/", async (c) => c.json(await runScan({})));

/** Pre-flight context KeeperHub composes from on-chain reads, cross-checked
 *  against the keeper's own observation. Numeric fields arrive as decimal
 *  strings to preserve uint256 precision through JSON. */
export interface KhContext {
  tav?: string;
  agentEth?: string;
  poolKeys?: string[];
  source?: string;
}

export interface ScanRunOpts {
  forcePool?: string;
  bypassAntiwhip?: boolean;
  khContext?: KhContext;
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

  // Build the KH-context line as part of the rollup input rather than
  // emitting it as its own ring entry.
  const khLines: string[] = [];
  if (opts.khContext) {
    const c = opts.khContext;
    let ownTvl: bigint | null = null;
    if (c.tav) {
      try { ownTvl = await readTotalAssets(); } catch { /* skip */ }
    }
    const parts: string[] = [];
    if (c.tav) {
      const khTvl = BigInt(c.tav);
      parts.push(`KH-supplied TVL ${(Number(khTvl) / 1e6).toFixed(4)} USDC`);
      if (ownTvl !== null) {
        const diff = ownTvl > khTvl ? ownTvl - khTvl : khTvl - ownTvl;
        const diffBps = Number((diff * 10000n) / (khTvl === 0n ? 1n : khTvl));
        parts.push(diffBps <= 1
          ? `cross-check ✓ matches keeper's own read`
          : `⚠ diverges from keeper's own read by ${diffBps}bps`);
      }
    }
    if (c.agentEth) parts.push(`agent gas ${(Number(c.agentEth) / 1e18).toFixed(6)} ETH`);
    if (c.poolKeys?.length) {
      const ownCount = result.pools.length;
      const khCount = c.poolKeys.length;
      parts.push(khCount === ownCount
        ? `KH-supplied pool roster matches (${khCount})`
        : `⚠ pool roster diverges: KH ${khCount} vs keeper ${ownCount}`);
    }
    if (parts.length > 0) khLines.push(`[kh-context] ${parts.join("; ")}.`);
  }

  const txs: string[] = [];
  let actuated = false;
  let dryRun = false;

  if (ACTUATING.has(result.chosen.action)) {
    if (!result.chosenContext) {
      result.chosen = {
        action: "hold",
        pool: result.chosen.pool,
        reasoning: `${result.chosen.reasoning} — execution context unresolved; downgraded to hold.`,
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
        const msg = (e as Error).message;
        result.chosen = {
          action: "hold",
          pool: result.chosen.pool,
          reasoning: `execution failed: ${msg}; ${result.chosen.reasoning}`,
          policy: result.chosen.policy,
        };
        bumpHoldCounter();
      }
      if (exec) {
        txs.push(exec.txHash);
        actuated = true;
        dryRun = exec.dryRun;
        if (result.chosen.pool) markCooldown(result.chosen.pool, result.chosen.action, exec.txHash);
        resetHoldCounter();

        // Actuation gets exactly one feed entry: the action narration. The
        // tx and Uniswap-SDK consult appear as sources on that single entry
        // so the integration stays visible without a second debug line.
        const actuationSources = !exec.dryRun ? [
          { kind: "basescan" as const, label: "rebalance tx", tx: exec.txHash },
          { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
        ] : undefined;
        const recentForAction = [
          ...result.thoughts.map(decisionToSignalText),
          ...exec.consultations,
          decisionToSignalText(result.chosen),
        ];
        void narrateActionAsync(result.chosen, recentForAction, actuationSources);
      }
    }
  } else {
    // No actuation this tick. Roll up everything the engine reasoned about
    // (per-policy thoughts, anti-whipsaw holds, KH context) and let the
    // narrator decide whether anything is worth saying. Returns null →
    // emit nothing.
    if (result.chosen.action === "hold") bumpHoldCounter();
    const reasonings: string[] = [
      ...khLines,
      ...result.thoughts.map(decisionToSignalText),
      decisionToSignalText(result.chosen),
    ];
    const recent = recentRingTexts(12);
    void (async () => {
      const polished = await rollupTick(reasonings, { recentDecisions: recent });
      if (polished) await signal(polished);
    })();
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
  const text = polished ? `[${decision.policy}] ${polished}` : decisionToSignalText(decision);
  await signal(text, { sources });
}
