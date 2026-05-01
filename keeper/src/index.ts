// Keeper service entry. Hono app on port KEEPER_PORT (default 8788).
// Booted by `bun run src/index.ts`. Sister process to ~/alp/backend on
// 8787; the two share INGEST_SECRET so the keeper can POST narration to
// /ingest/signal without rotating env.

import { Hono } from "hono";

import { env, DRY_RUN } from "./env";
import { account } from "./chain";
import { readVaultAgent } from "./vault";
import { healthRouter } from "./routes/health";
import { scanRouter, runScan } from "./routes/scan";
import { forceRouter } from "./routes/force";

const app = new Hono();

app.route("/health", healthRouter);
app.route("/scan", scanRouter);
app.route("/force", forceRouter);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[keeper] unhandled error:", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// Boot-time sanity check: derived address must equal vault.agent(). Logs
// loudly and continues if it doesn't (helps when developing against a
// fork or testnet); production deployment should hard-fail here.
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

// Optional internal /scan ticker. Used for soak testing when no
// KeeperHub workflow is yet calling /scan externally. Fires the same
// runScan that the HTTP route does, so anti-whipsaw and DRY_RUN gates
// behave identically. Errors are logged and swallowed — never crash
// the process. KH (Phase 4) replaces this with an external schedule;
// safe to leave both running.
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
