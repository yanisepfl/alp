// GET /health — public, no auth. Surfaces the keeper's identity and
// last-action telemetry so KeeperHub uptime monitoring + scripts can
// verify the keeper is alive and pointing at the right vault.

import { Hono } from "hono";

import { account } from "../chain";
import { db } from "../db";
import { env } from "../env";

export const healthRouter = new Hono();

healthRouter.get("/", (c) => {
  const last = db
    .prepare(
      `SELECT pool, last_action, last_action_at, last_tx
       FROM pool_cooldowns ORDER BY last_action_at DESC LIMIT 1`,
    )
    .get() as
    | { pool: string; last_action: string; last_action_at: number; last_tx: string | null }
    | undefined;
  const lastTickAt = (db
    .prepare(`SELECT last_tick_at FROM hold_counter WHERE id = 1`)
    .get() as { last_tick_at: number | null } | undefined)?.last_tick_at ?? null;

  return c.json({
    status: "ok",
    agent_address: account.address,
    vault_address: env.VAULT_ADDRESS,
    port: env.KEEPER_PORT,
    last_tick_at: lastTickAt,
    last_action_at: last?.last_action_at ?? null,
    last_action: last?.last_action ?? null,
    last_action_pool: last?.pool ?? null,
    last_tx: last?.last_tx ?? null,
  });
});
