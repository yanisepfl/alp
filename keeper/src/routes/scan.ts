import { Hono } from "hono";

import { bumpHoldCounter, markCooldown, resetHoldCounter, readHoldCounter } from "../db";
import { tick } from "../engine";
import { env } from "../env";
import { execute } from "../executor";
import { decisionToSignalText, signal, type WireSource } from "../ingest";
import { rewriteAction, rewriteSignal, rewriteThought } from "../narrator";
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

  if (opts.khContext) {
    const c = opts.khContext;
    let ownTvl: bigint | null = null;
    if (c.tav) {
      try { ownTvl = await readTotalAssets(); } catch { /* skip cross-check */ }
    }

    const parts: string[] = [];
    if (c.tav) {
      const khTvl = BigInt(c.tav);
      parts.push(`TVL ${(Number(khTvl) / 1e6).toFixed(4)} USDC`);
      if (ownTvl !== null) {
        const diff = ownTvl > khTvl ? ownTvl - khTvl : khTvl - ownTvl;
        const diffBps = Number((diff * 10000n) / (khTvl === 0n ? 1n : khTvl));
        parts.push(diffBps <= 1
          ? `cross-check ✓ matches own read of ${(Number(ownTvl) / 1e6).toFixed(4)} USDC`
          : `⚠ diverges from own read of ${(Number(ownTvl) / 1e6).toFixed(4)} USDC by ${diffBps}bps`);
      }
    }
    if (c.agentEth) parts.push(`agent gas ${(Number(c.agentEth) / 1e18).toFixed(6)} ETH`);
    if (c.poolKeys?.length) {
      const ownCount = result.pools.length;
      const khCount = c.poolKeys.length;
      parts.push(khCount === ownCount
        ? `pool roster ✓ ${khCount} active`
        : `⚠ pool roster diverges: KH ${khCount} vs keeper ${ownCount}`);
    }
    if (parts.length > 0) {
      const summary = `KeeperHub pre-tick (source=${c.source ?? "kh"}): ${parts.join("; ")}.`;
      void narrateSignalAsync("kh-context", summary, []);
    }
  }

  const txs: string[] = [];
  let actuated = false;
  let dryRun = false;

  const thoughtRecent = result.thoughts.map(decisionToSignalText);
  for (const t of result.thoughts) {
    if (t.action === "thought") {
      void narrateThoughtAsync(t, thoughtRecent);
    }
  }

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

        const actuationSources = !exec.dryRun ? [
          { kind: "basescan" as const, label: "rebalance tx", tx: exec.txHash },
          { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
        ] : undefined;
        for (const line of exec.consultations) {
          void narrateSignalAsync("uniswap-sdk", line, thoughtRecent, actuationSources);
        }
        const recentForAction = [
          ...thoughtRecent,
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
  const text = polished ? `[${decision.policy}] ${polished}` : decisionToSignalText(decision);
  await signal(text, { sources });
}

async function narrateThoughtAsync(decision: Decision, recent: readonly string[]): Promise<void> {
  const polished = await rewriteThought(decision, { recentDecisions: recent });
  const text = polished ? `[${decision.policy}] ${polished}` : decisionToSignalText(decision);
  await signal(text);
}

async function narrateSignalAsync(policy: string, rawText: string, recent: readonly string[], sources?: WireSource[]): Promise<void> {
  const polished = await rewriteSignal(rawText, policy, { recentDecisions: recent });
  const text = polished ? `[${policy}] ${polished}` : `[${policy}] ${rawText}`;
  await signal(text, { sources });
}
