import { Hono } from "hono";

import { bumpHoldCounter, markCooldown, resetHoldCounter, readHoldCounter, recentRingTexts } from "../db";
import { tick } from "../engine";
import { execute } from "../executor";
import { decisionToSignalText, signal, thought, type WireSource } from "../ingest";
import { narrateUserEventReaction, rewriteAction, rollupTick } from "../narrator";
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

/** A user-flow event the backend forwards to the keeper so the engine can
 *  immediately reason about it. The keeper emits one signal naming the
 *  flow, runs the engine, emits one reaction-thought, and (if the engine
 *  chose to actuate) one action — instead of waiting up to 5 minutes for
 *  the next polling tick. */
export interface UserEvent {
  kind: "deposit" | "withdraw";
  assetsRaw: string;
  user: string;
  tx: string;
}

export interface ScanRunOpts {
  forcePool?: string;
  bypassAntiwhip?: boolean;
  khContext?: KhContext;
  userEvent?: UserEvent;
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

  // User-flow events (deposit/withdraw) get a single context signal in
  // the feed naming the flow before any engine reasoning lands. The
  // follow-up reaction-thought + optional action are scheduled below.
  if (opts.userEvent) {
    const e = opts.userEvent;
    const amt = (Number(BigInt(e.assetsRaw)) / 1e6).toFixed(4);
    const userShort = `${e.user.slice(0, 6)}…${e.user.slice(-4)}`;
    const verb = e.kind === "deposit" ? "Deposit" : "Withdrawal";
    const txOk = /^0x[0-9a-fA-F]{64}$/.test(e.tx);
    void signal(`${verb} of ${amt} USDC from ${userShort}.`, {
      sources: txOk ? [{ kind: "basescan", label: `${e.kind} tx`, tx: e.tx }] : undefined,
    });
  }

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
    if (parts.length > 0) khLines.push(`KeeperHub pre-flight context: ${parts.join("; ")}.`);
  }

  const txs: string[] = [];
  let actuated = false;
  let dryRun = false;
  let actionConsultations: readonly string[] = [];
  let actionTxHash: string | undefined;
  let actionDryRun = false;

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
        actionConsultations = exec.consultations;
        actionTxHash = exec.txHash;
        actionDryRun = exec.dryRun;
        if (result.chosen.pool) markCooldown(result.chosen.pool, result.chosen.action, exec.txHash);
        resetHoldCounter();
      }
    }
  } else if (result.chosen.action === "hold") {
    bumpHoldCounter();
  }

  const reasonings: string[] = [
    ...khLines,
    ...result.thoughts.map(decisionToSignalText),
    decisionToSignalText(result.chosen),
  ];
  const recent = recentRingTexts(12);

  // Narration scheduling. Three independent paths feed the same async
  // queue; ordering between them is best-effort (claude subprocess
  // timings vary). For user-flow /react calls we always emit a thought,
  // even when actuating, so the depositor sees the agent's reasoning
  // separately from the action card.
  if (opts.userEvent) {
    const e = opts.userEvent;
    const amountUsdc = Number(BigInt(e.assetsRaw)) / 1e6;
    void (async () => {
      const polished = await narrateUserEventReaction(
        { kind: e.kind, amountUsdc, user: e.user, tx: e.tx },
        { chosenAction: result.chosen.action, chosenPool: result.chosen.pool, reasonings },
        { recentDecisions: recent },
      );
      if (polished) await thought(polished);
    })();
  } else if (!actuated) {
    void (async () => {
      const polished = await rollupTick(reasonings, { recentDecisions: recent });
      if (polished) await thought(polished);
    })();
  }

  if (actuated && actionTxHash) {
    const actuationSources = !actionDryRun ? [
      { kind: "basescan" as const, label: "rebalance tx", tx: actionTxHash },
      { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
    ] : undefined;
    const recentForAction = [
      ...result.thoughts.map(decisionToSignalText),
      ...actionConsultations,
      decisionToSignalText(result.chosen),
    ];
    void narrateActionAsync(result.chosen, recentForAction, actuationSources);
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
  // Action narration is the agent's first-person account of what it
  // just did — this is a thought, not external context. The basescan
  // tx + Uniswap-SDK consult sources stay attached to the signal-side
  // entries so the user can still drill in.
  if (polished) {
    await thought(polished);
  } else {
    // Narrator failed/timed out — fall back to a plain context signal
    // so the action still lands in the feed with sources attached.
    await signal(decisionToSignalText(decision), { sources });
  }
}
