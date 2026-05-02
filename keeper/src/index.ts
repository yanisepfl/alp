import { Hono } from "hono";

import { env, DRY_RUN } from "./env";
import { account } from "./chain";
import { readVaultAgent } from "./vault";
import { healthRouter } from "./routes/health";
import { scanRouter, runScan } from "./routes/scan";
import { forceRouter } from "./routes/force";
import { postRebalanceRouter } from "./routes/postRebalance";
import { logTickRouter } from "./routes/logTick";

const app = new Hono();

app.use("*", async (c, next) => {
  console.log(`[req] ${c.req.method} ${c.req.path}${c.req.url.includes("?") ? "?…" : ""} ua="${c.req.header("user-agent")?.slice(0, 40) ?? "-"}"`);
  await next();
});

app.route("/health", healthRouter);
app.route("/scan", scanRouter);
app.route("/force", forceRouter);
app.route("/post-rebalance", postRebalanceRouter);
app.route("/log-tick", logTickRouter);

// Trailing-slash redirect preserves the query string for orchestrators
// (e.g. KeeperHub) that occasionally append a slash to bare paths.
for (const path of ["/scan", "/force", "/post-rebalance", "/log-tick"]) {
  app.all(`${path}/`, async (c) => {
    const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";
    return c.redirect(`${path}${qs}`, 307);
  });
}

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[keeper] unhandled error:", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

async function bootChecks(): Promise<void> {
  try {
    const onchain = await readVaultAgent();
    if (onchain.toLowerCase() !== account.address.toLowerCase()) {
      console.warn(
        `[keeper] WARNING: signer ${account.address} != vault.agent() ${onchain}. ` +
        `Tx writes will revert with onlyAgent — fix AGENT_PRIVATE_KEY.`,
      );
    } else {
      console.log(`[keeper] signer matches vault.agent() = ${onchain}`);
    }
  } catch (e) {
    console.warn(`[keeper] vault.agent() read failed: ${(e as Error).message}`);
  }
}

console.log(`[keeper] DRY_RUN=${DRY_RUN}, port=${env.KEEPER_PORT}, signer=${account.address}`);
void bootChecks();

// Optional internal ticker — exists for soak testing without an external
// orchestrator. KEEPER_INTERNAL_TICK_MS unset → no-op.
if (env.KEEPER_INTERNAL_TICK_MS) {
  const intervalMs = env.KEEPER_INTERNAL_TICK_MS;
  console.log(`[keeper] internal tick enabled — firing /scan every ${intervalMs}ms`);
  setInterval(() => {
    runScan({}).then((r) => {
      console.log(`[keeper] internal tick → ${r.chosen.action} (${r.chosen.policy}); pools=${r.meta.pools}, actuated=${r.meta.actuated}`);
    }).catch((e) => {
      console.warn(`[keeper] internal tick error: ${(e as Error).message}`);
    });
  }, intervalMs);
}

export default {
  port: env.KEEPER_PORT,
  fetch: app.fetch,
};
