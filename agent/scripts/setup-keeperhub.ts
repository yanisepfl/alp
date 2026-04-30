/** KeeperHub workflow utilities.
 *
 *  Usage modes:
 *
 *    pnpm deploy:keeperhub              # default: list + status check
 *    pnpm deploy:keeperhub download     # GET workflow JSON, save to keeperhub-workflow.live.json
 *    pnpm deploy:keeperhub patch        # PATCH workflow with current keeperhub-workflow.live.json
 *    pnpm deploy:keeperhub clean        # delete every workflow named "ALP Rebalance Loop"
 *
 *  Why no full create+activate path: KH's REST `/api/workflows/create`
 *  accepts our (name, nodes, edges) shape but the per-node action `type`
 *  + `config` schema isn't documented or exposed via REST — only via the
 *  hosted MCP server's `list_action_schemas` tool. So workflows authored
 *  outside the UI come back as empty shells.
 *
 *  Recommended flow:
 *    1. Build the workflow ONCE in app.keeperhub.com (5-10 min, drag the
 *       Schedule trigger → HTTP Request → Condition → Telegram nodes).
 *    2. Run `pnpm deploy:keeperhub download` to fetch the canonical JSON.
 *    3. Commit `keeperhub-workflow.live.json` as the source of truth for
 *       any future PATCHes.
 *    4. Use `pnpm deploy:keeperhub patch` to push edits from the file.
 *
 *  See agent/README.md for the manual UI build steps + the optional MCP
 *  integration path that satisfies the "depth" criterion of the
 *  Best Integration prize without needing this script at all.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { KeeperHubClient } from "../src/keeperhub.js";

const WORKFLOW_NAME = "ALP Rebalance Loop";
const LIVE_PATH = resolve(import.meta.dirname, "..", "keeperhub-workflow.live.json");

async function main(): Promise<void> {
  const apiKey = required("KEEPERHUB_API_KEY");
  const kh = new KeeperHubClient({ apiKey });
  const cmd = (process.argv[2] ?? "status").toLowerCase();

  switch (cmd) {
    case "status":
      await status(kh);
      return;
    case "download":
      await download(kh);
      return;
    case "patch":
      await patch(kh);
      return;
    case "clean":
      await clean(kh);
      return;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      console.error(`usage: pnpm deploy:keeperhub [status|download|patch|clean]`);
      process.exit(1);
  }
}

async function status(kh: KeeperHubClient): Promise<void> {
  const all = await kh.listWorkflows();
  const ours = all.filter((w) => w.name === WORKFLOW_NAME);
  console.log(`KeeperHub workflows: ${all.length} total, ${ours.length} matching "${WORKFLOW_NAME}"`);
  for (const w of ours) {
    console.log(`  ${w.id}  enabled=${w.enabled ?? "?"}  https://app.keeperhub.com/workflows/${w.id}`);
  }
  if (ours.length === 0) {
    console.log(`\n  no live workflow yet — build one in the UI:`);
    console.log(`  https://app.keeperhub.com/workflows/new`);
    console.log(`  see agent/README.md → KeeperHub integration for the recipe.`);
  } else if (ours.length > 1) {
    console.log(`\n  multiple workflows match — run 'pnpm deploy:keeperhub clean' to dedupe.`);
  } else {
    console.log(`\n  next: 'pnpm deploy:keeperhub download' to snapshot the live workflow.`);
  }
}

async function download(kh: KeeperHubClient): Promise<void> {
  const all = await kh.listWorkflows();
  const ours = all.filter((w) => w.name === WORKFLOW_NAME);
  if (ours.length === 0) {
    console.error(`no workflow named "${WORKFLOW_NAME}" found in KH. Build it first in the UI.`);
    process.exit(1);
  }
  if (ours.length > 1) {
    console.error(`${ours.length} workflows match — run 'clean' first.`);
    process.exit(1);
  }
  const json = await kh.getWorkflow(ours[0].id);
  writeFileSync(LIVE_PATH, JSON.stringify(json, null, 2) + "\n");
  console.log(`wrote ${LIVE_PATH}`);
  console.log(`commit it so future PATCHes have a versioned source of truth.`);
}

async function patch(kh: KeeperHubClient): Promise<void> {
  if (!existsSync(LIVE_PATH)) {
    console.error(`${LIVE_PATH} doesn't exist. Run 'pnpm deploy:keeperhub download' first.`);
    process.exit(1);
  }
  const all = await kh.listWorkflows();
  const ours = all.filter((w) => w.name === WORKFLOW_NAME);
  if (ours.length !== 1) {
    console.error(`need exactly 1 "${WORKFLOW_NAME}" workflow, found ${ours.length}.`);
    process.exit(1);
  }
  const definition = JSON.parse(readFileSync(LIVE_PATH, "utf8"));
  await kh.updateWorkflow(ours[0].id, definition);
  console.log(`patched workflow ${ours[0].id} from ${LIVE_PATH}`);
}

async function clean(kh: KeeperHubClient): Promise<void> {
  const all = await kh.listWorkflows();
  const dups = all.filter((w) => w.name === WORKFLOW_NAME);
  if (dups.length === 0) {
    console.log(`nothing to clean.`);
    return;
  }
  console.log(`deleting ${dups.length} workflow(s) named "${WORKFLOW_NAME}":`);
  for (const w of dups) {
    try {
      await kh.deleteWorkflow(w.id);
      console.log(`  deleted ${w.id}`);
    } catch (e) {
      console.log(`  failed ${w.id}: ${(e as Error).message}`);
    }
  }
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
  console.error(`[kh] ${e.message ?? e}`);
  process.exit(1);
});
