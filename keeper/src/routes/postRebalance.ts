import { Hono } from "hono";

import { publicClient } from "../chain";
import { signal } from "../ingest";
import { rewriteSignal } from "../narrator";
import { requireBearer } from "./auth";

interface PostRebalanceBody {
  event?: {
    tx?: string;
    poolKey?: string;
    blockNumber?: number | string;
    positionId?: string;
    amount0Used?: string;
    amount1Used?: string;
    eventName?: string;
  };
  basketState?: {
    poolValues?: Array<{ success?: boolean; result?: string; error?: string }> | string;
    deployedTotal?: string;
    agentEthAfter?: string;
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

  let verified = false;
  let receiptError: string | null = null;
  if (tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: tx as `0x${string}` });
      verified = receipt.status === "success";
      if (!verified) receiptError = `receipt status=${receipt.status}`;
    } catch (e) {
      receiptError = (e as Error).message;
      console.warn(`[post-rebalance] receipt lookup failed for ${tx}: ${receiptError}`);
    }
  }

  // Default: KH workflow ran cleanly, receipt confirmed → return 200
  // silently. The rebalance itself already produced an action narration
  // and the on-chain LiquidityAdded/Removed entries via the indexer; a
  // second [kh-event] line saying "audit confirmed" is pure noise.
  // We only surface a feed entry when the audit actually caught
  // something the user should know about: a failed receipt, or anomaly
  // in the basket-state snapshot.
  const noteworthy = !verified && tx !== undefined;
  if (!noteworthy) return c.json({ ok: true, verified, narrated: false });

  const parts: string[] = [];
  parts.push(`Audit flagged vault.${eventName}`);
  if (receiptError) parts.push(`receipt issue: ${receiptError}`);
  if (poolKey) parts.push(`triggered by pool ${poolKey.slice(0, 12)}…`);
  if (body.event?.positionId) parts.push(`new position #${body.event.positionId}`);
  const bs = body.basketState;
  if (bs) {
    const fmt6 = (raw?: string) => raw ? (Number(raw) / 1e6).toFixed(4) : "?";
    let pv: Array<{ success?: boolean; result?: string }> | undefined;
    if (typeof bs.poolValues === "string") {
      try { pv = JSON.parse(bs.poolValues); } catch { /* skip */ }
    } else if (Array.isArray(bs.poolValues)) {
      pv = bs.poolValues;
    }
    if (pv && pv.length >= 3) {
      const labels = ["USDC/USDT", "USDC/cbBTC", "ETH/USDC"];
      const perPool = pv.slice(0, 3).map((r, i) => `${labels[i]} ${fmt6(r?.result)}`).join(", ");
      parts.push(`basket: ${perPool}`);
    }
    if (bs.deployedTotal) {
      parts.push(`deployed total ${fmt6(bs.deployedTotal)} USDC (KH math/aggregate)`);
    }
    if (bs.agentEthAfter) {
      parts.push(`agent gas after ${(Number(bs.agentEthAfter) / 1e18).toFixed(6)} ETH`);
    }
  }
  if (verified) parts.push("receipt confirmed");
  const rawText = parts.join(", ") + ".";

  const sources = tx
    ? [
        { kind: "basescan" as const, label: "rebalance tx", tx },
        { kind: "uniswap" as const, label: "Uniswap V3/V4 SDK consult", url: "https://developers.uniswap.org/docs/liquidity/overview" },
      ]
    : undefined;

  void (async () => {
    const polished = await rewriteSignal(rawText, "KeeperHub post-rebalance audit", { recentDecisions: [] });
    await signal(polished ?? rawText, { sources });
  })();

  return c.json({ ok: true, verified, narrated: true });
});
