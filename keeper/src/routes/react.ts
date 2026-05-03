// POST /react — backend-triggered. Tells the keeper a vault depositor or
// holder just moved USDC. The keeper emits a header signal naming the
// flow, runs the engine immediately (instead of waiting up to 5 minutes
// for the next /scan tick), emits a one-sentence reaction-thought
// reasoning about whether to rebalance, and (if the engine chose to
// actuate) executes the rebalance and emits the action narration too.

import { Hono } from "hono";

import { runScan, type UserEvent } from "./scan";
import { requireBearer } from "./auth";

interface ReactBody {
  kind?: "deposit" | "withdraw";
  assets?: string;
  user?: string;
  tx?: string;
}

export const reactRouter = new Hono();
reactRouter.use("*", requireBearer);

reactRouter.post("/", async (c) => {
  let body: ReactBody = {};
  try { body = await c.req.json(); } catch { /* fall through to validation */ }

  if (body.kind !== "deposit" && body.kind !== "withdraw") {
    return c.json({ error: "kind must be 'deposit' or 'withdraw'" }, 400);
  }
  if (typeof body.assets !== "string" || !/^\d+$/.test(body.assets)) {
    return c.json({ error: "assets must be a decimal-string uint256" }, 400);
  }
  if (typeof body.user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.user)) {
    return c.json({ error: "user must be a 0x-prefixed address" }, 400);
  }
  if (typeof body.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.tx)) {
    return c.json({ error: "tx must be a 0x-prefixed tx hash" }, 400);
  }

  const userEvent: UserEvent = {
    kind: body.kind,
    assetsRaw: body.assets,
    user: body.user,
    tx: body.tx,
  };
  return c.json(await runScan({ userEvent }));
});
