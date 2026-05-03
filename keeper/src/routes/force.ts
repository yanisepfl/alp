// POST /force?pool=<addr> — bearer-authed. Runs the engine with
// anti-whipsaw bypassed and (if pool param given) prefers any actuating
// Candidate that targets that pool. Used in the demo to pre-fire scene 1
// on a specific pool so scene 4's autonomous tick lands on a different
// one.

import { Hono } from "hono";

import { runScan } from "./scan";
import { requireBearer } from "./auth";

export const forceRouter = new Hono();

forceRouter.use("*", requireBearer);

forceRouter.post("/", async (c) => {
  const pool = c.req.query("pool");
  const result = await runScan({
    forcePool: pool ?? undefined,
    bypassAntiwhip: true,
  });
  return c.json(result);
});
