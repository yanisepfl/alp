/** One-shot script to deploy the ALP rebalance workflow to KeeperHub.
 *
 *  Replaces the missing `kh workflow apply` command (KeeperHub doesn't ship
 *  one — workflow definitions live in the dashboard, MCP, or REST). We
 *  POST /api/workflows/create with our committed workflow JSON, then PATCH
 *  the result to merge nodes/edges, then `go-live`. Idempotent: if a
 *  workflow with the same name already exists, we PATCH instead of create.
 *
 *  Usage:
 *    KEEPERHUB_API_KEY=kh_... \
 *    ALP_WORKER_URL=alp.example.workers.dev \
 *    ALP_API_KEY=long_random \
 *    TELEGRAM_BOT_TOKEN=... \
 *    TELEGRAM_CHAT_ID=... \
 *    pnpm tsx scripts/setup-keeperhub.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KeeperHubClient } from "../src/keeperhub.js";

const WORKFLOW_NAME = "ALP Rebalance Loop";

async function main(): Promise<void> {
  const apiKey = required("KEEPERHUB_API_KEY");
  const workerUrl = required("ALP_WORKER_URL");
  const inboundApiKey = required("ALP_API_KEY");
  const tgBotToken = required("TELEGRAM_BOT_TOKEN");
  const tgChatId = required("TELEGRAM_CHAT_ID");

  const tmpl = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "keeperhub-workflow.json"), "utf8"),
  ) as { name: string; description?: string; trigger: unknown; nodes: unknown[]; secrets?: unknown };

  // Inline secret substitutions ${ALP_WORKER_URL} → actual values. Keeps the
  // committed workflow JSON env-agnostic so it can be reviewed without
  // redaction.
  const definition = JSON.parse(
    JSON.stringify({ trigger: tmpl.trigger, nodes: tmpl.nodes }, null, 2)
      .replaceAll("${ALP_WORKER_URL}", workerUrl)
      .replaceAll("${ALP_API_KEY}", inboundApiKey)
      .replaceAll("${TG_BOT_TOKEN}", tgBotToken)
      .replaceAll("${TG_CHAT_ID}", tgChatId),
  ) as { trigger: unknown; nodes: unknown[] };

  const kh = new KeeperHubClient({ apiKey });

  // Idempotent upsert: list, find by name, create or patch.
  const existing = await kh.listWorkflows();
  const found = existing.find((w) => w.name === WORKFLOW_NAME);

  let id: string;
  if (found) {
    console.log(`[kh] reusing existing workflow ${found.id} (status: ${found.status})`);
    id = found.id;
  } else {
    const created = await kh.createWorkflow(WORKFLOW_NAME, tmpl.description);
    console.log(`[kh] created workflow ${created.id}`);
    id = created.id;
  }

  await kh.updateWorkflow(id, definition);
  console.log(`[kh] patched workflow ${id} with nodes/edges`);

  // Activate so the schedule trigger starts firing.
  try {
    await kh.goLive(id);
    console.log(`[kh] workflow ${id} is now LIVE`);
  } catch (e) {
    console.warn(`[kh] go-live failed (already live?): ${(e as Error).message}`);
  }

  console.log(`\n✅ ALP rebalance loop deployed.`);
  console.log(`   Dashboard: https://app.keeperhub.com/workflows/${id}`);
  console.log(`   Trigger:   schedule (cron */5 * * * *) → POST ${workerUrl}/trigger`);
  console.log(`   Notify:    Telegram chat ${tgChatId} on rebalances > 0`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return v;
}

main().catch((e) => {
  console.error(`[kh] setup failed: ${e.message ?? e}`);
  process.exit(1);
});
