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

// KH workflows call /log-tick on every workflow run (3 workflows × every 5
// min). The /scan rollup already distills the keeper's brain per tick — so
// the only KH-tick outcomes worth surfacing here are the genuinely
// noteworthy ones the brain doesn't see: low gas, errors, or unknown
// outcomes the workflow chose to flag with a non-empty `detail`. Common
// "held" / "fired" cases return 200 silently to keep the feed agentic.
logTickRouter.post("/", async (c) => {
  let body: LogTickBody = {};
  try { body = await c.req.json(); } catch { /* empty body fine */ }

  const outcome = body.outcome ?? "unknown";
  const noteworthy =
    outcome === "low_gas" ||
    (outcome !== "held" && outcome !== "fired" && body.detail !== undefined);
  if (!noteworthy) return c.json({ ok: true, narrated: false });

  const parts: string[] = [];
  if (outcome === "low_gas") {
    parts.push("Skipped this tick — agent gas runway low");
  } else {
    parts.push(`Workflow flagged ${outcome}`);
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
