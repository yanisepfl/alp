/** Local Node entrypoint for testing the agent against a forked or live RPC.
 *
 *  Usage:
 *    BASE_RPC_URL=... VAULT_ADDRESS=... ... pnpm local
 */
import { loadConfig } from "./config.js";
import { MemoryActivityStore } from "./log.js";
import type { PositionHysteresis } from "./planner.js";
import { runTick } from "./runner.js";

async function main() {
  const config = loadConfig(process.env);
  const store = new MemoryActivityStore();
  const state = new Map<string, PositionHysteresis>();

  console.log("Running one tick…");
  const result = await runTick({
    config,
    store,
    loadHysteresis: async () => state,
    saveHysteresis: async (s) => {
      state.clear();
      for (const [k, v] of s) state.set(k, v);
    },
  });
  console.log("Result:", result);
  console.log("Activity:", await store.recent(20));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
