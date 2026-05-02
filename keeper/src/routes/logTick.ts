import { Hono } from "hono";

import { signal } from "../ingest";
import { rewriteSignal } from "../narrator";
import { requireBearer } from "./auth";

interface LogTickBody {
  outcome?: "low_gas" | "fired" | "held" | string;
  tvl?: string;
  agentEth?: string;
  poolCount?: number;
  txs?: string[];
  detail?: string;
}

export const logTickRouter = new Hono();
logTickRouter.use("*", requireBearer);

logTickRouter.post("/", async (c) => {
  let body: LogTickBody = {};
  try { body = await c.req.json(); } catch { /* empty body fine */ }

  const outcome = body.outcome ?? "unknown";
  const parts: string[] = [];
  switch (outcome) {
    case "low_gas":
      parts.push("Skipped this tick — agent gas runway low");
      break;
    case "fired":
      parts.push("Workflow finished — rebalance fired");
      break;
    case "held":
      parts.push("Workflow finished — keeper held this tick");
      break;
    default:
      parts.push(`Workflow finished (${outcome})`);
  }
  if (body.tvl)       parts.push(`TVL ${(Number(body.tvl) / 1e6).toFixed(4)} USDC`);
  if (body.agentEth)  parts.push(`agent gas ${(Number(body.agentEth) / 1e18).toFixed(6)} ETH`);
  if (body.poolCount !== undefined) parts.push(`${body.poolCount} active pools`);
  if (body.detail)    parts.push(body.detail);
  const rawText = parts.join("; ") + ".";

  const sources = body.txs?.length
    ? body.txs.filter((t) => /^0x[0-9a-fA-F]{64}$/.test(t)).map((tx) => ({
        kind: "basescan" as const, label: "tick tx", tx,
      }))
    : undefined;

  void (async () => {
    const polished = await rewriteSignal(rawText, "kh-tick", { recentDecisions: [] });
    const text = polished ? `[kh-tick] ${polished}` : `[kh-tick] ${rawText}`;
    await signal(text, { sources });
  })();

  return c.json({ ok: true, narrated: true });
});
