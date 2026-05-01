// POST /post-rebalance — receives KeeperHub's reactive-workflow payload
// after a vault.LiquidityRemoved/Added event fires on chain. KH has
// already done supplementary chain reads (TAV, agent ETH, pool tick)
// and we narrate them as a distinct signal-lane entry. Different from
// the backend indexer's auto-folded kind:"action" entries — this is
// the "KH said it happened, here's a health snapshot" cross-check.
//
// Auth: same Bearer / ?token= fallback as /scan and /force.

import { Hono } from "hono";

import { decodeEventLog, type Address } from "viem";

import { vaultEventsAbi } from "../abi";
import { publicClient } from "../chain";
import { env } from "../env";
import { signal } from "../ingest";
import { rewriteSignal } from "../narrator";
import { requireBearer } from "./auth";

interface PostRebalanceBody {
  event?: {
    tx?: string;
    poolKey?: string;
    blockNumber?: number | string;
    amount0?: string;
    amount1?: string;
    eventName?: string;
  };
  postState?: {
    tavAfter?: string;
    agentEthAfter?: string;
    tickAfter?: number;
  };
}

export const postRebalanceRouter = new Hono();
postRebalanceRouter.use("*", requireBearer);

postRebalanceRouter.post("/", async (c) => {
  let body: PostRebalanceBody = {};
  try { body = await c.req.json(); } catch { /* empty body fine */ }

  const tx = body.event?.tx;
  const poolKey = body.event?.poolKey;
  const eventName = body.event?.eventName ?? "rebalance event";

  // Optional verification: if a tx hash was supplied, look up the receipt
  // and confirm the chain saw it. Failure here is logged but doesn't
  // block narration — KH's event trigger is authoritative for "it
  // happened"; verification just hardens the entry.
  let verified = false;
  if (tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: tx as `0x${string}` });
      verified = receipt.status === "success";
    } catch (e) {
      console.warn(`[post-rebalance] receipt lookup failed for ${tx}: ${(e as Error).message}`);
    }
  }

  // Build a narration line with whatever fields KH gave us.
  const parts: string[] = [];
  parts.push(`Detected vault.${eventName} on chain`);
  if (poolKey) parts.push(`pool ${poolKey.slice(0, 12)}…`);
  if (tx) parts.push(`tx ${tx.slice(0, 12)}…`);
  if (body.postState?.tavAfter) {
    parts.push(`TAV ${(Number(body.postState.tavAfter) / 1e6).toFixed(4)} USDC`);
  }
  if (body.postState?.agentEthAfter) {
    parts.push(`agent ETH ${(Number(body.postState.agentEthAfter) / 1e18).toFixed(6)}`);
  }
  if (body.postState?.tickAfter !== undefined) {
    parts.push(`pool tick ${body.postState.tickAfter}`);
  }
  if (verified) parts.push("(receipt confirmed)");
  const rawText = parts.join(", ") + ".";

  // Sources: link to basescan if we have a tx hash so the entry shows
  // up grouped with the indexer's kind:"action" auto-folded entries on
  // the same tx.
  const sources = tx
    ? [
        { kind: "basescan" as const, label: "rebalance tx", tx },
        { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
      ]
    : undefined;

  // Narrate via the signal-lane Claude prompt; falls back to raw on timeout.
  void (async () => {
    const polished = await rewriteSignal(rawText, "kh-event", { recentDecisions: [] });
    const text = polished ? `[kh-event] ${polished}` : `[kh-event] ${rawText}`;
    await signal(text, { sources });
  })();

  return c.json({ ok: true, verified, narrated: true });
});
