// Keeper service entry. Hono app on port KEEPER_PORT (default 8788).
// Booted by `bun run src/index.ts`. Sister process to ~/alp/backend on
// 8787; the two share INGEST_SECRET so the keeper can POST narration to
// /ingest/signal without rotating env.

import { Hono } from "hono";

import { env, DRY_RUN } from "./env";
import { account } from "./chain";
import { readVaultAgent } from "./vault";
import { healthRouter } from "./routes/health";
import { scanRouter } from "./routes/scan";
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

export default {
  port: env.KEEPER_PORT,
  fetch: app.fetch,
};
