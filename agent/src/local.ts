/** Local Node entrypoint for testing the agent against a forked or live RPC.
 *
 *  Usage:
 *    BASE_RPC_URL=... VAULT_ADDRESS=... ... pnpm local
 */
import { readFileSync } from "node:fs";

import { loadConfig, parsePoolsJson } from "./config.js";
import { MemoryActivityStore } from "./log.js";
import type { PositionHysteresis } from "./planner.js";
import { runTick } from "./runner.js";

async function main() {
  const config = loadConfig(process.env);
  // Load pool list from POOLS_JSON_PATH if set (the local bootstrap writes
  // this file with the deployed pool keys).
  const poolsPath = process.env.POOLS_JSON_PATH;
  if (poolsPath) {
    config.pools = parsePoolsJson(readFileSync(poolsPath, "utf8"));
    console.log(`Loaded ${config.pools.length} pool(s) from ${poolsPath}`);
  }
  const store = new MemoryActivityStore();
  const state = new Map<string, PositionHysteresis>();

  // Mode: `pnpm local` runs once. Append `--dry` to print the plan without
  // submitting any transactions. Append `--force [positionKey]` to override
  // hysteresis and rebalance now.
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const forceIdx = args.indexOf("--force");
  const force = forceIdx !== -1;
  const nextArg = args[forceIdx + 1];
  const positionKey = force && nextArg && !nextArg.startsWith("--") ? nextArg : undefined;

  console.log(`Running one tick (dryRun=${dryRun}, force=${force}, positionKey=${positionKey ?? "all"})…`);
  const result = await runTick({
    config,
    store,
    loadHysteresis: async () => state,
    saveHysteresis: async (s) => {
      state.clear();
      for (const [k, v] of s) state.set(k, v);
    },
    options: { dryRun, force, positionKey },
  });
  console.log("Result:", JSON.stringify(result, jsonReplacer, 2));
  const activity = await store.recent(20);
  console.log("Activity:", JSON.stringify(activity, jsonReplacer, 2));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
