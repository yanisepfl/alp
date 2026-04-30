// SQLite via Bun's built-in driver. Schema is created on first open. The DB
// file lives under ./data/ which is gitignored.
//
// Tables:
//   pool_cooldowns       — anti-whipsaw: when did we last actuate on this pool?
//   pool_tick_history    — vol policy: rolling tick observations (Phase 2b).
//   hold_counter         — narration cadence: every Nth consecutive hold posts.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { env } from "./env";

mkdirSync(dirname(env.KEEPER_DB_PATH), { recursive: true });

export const db = new Database(env.KEEPER_DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS pool_cooldowns (
    pool TEXT PRIMARY KEY,
    last_action_at INTEGER NOT NULL,
    last_action TEXT NOT NULL,
    last_tx TEXT
  );
  CREATE TABLE IF NOT EXISTS pool_tick_history (
    pool TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    tick INTEGER NOT NULL,
    PRIMARY KEY (pool, observed_at)
  );
  CREATE TABLE IF NOT EXISTS hold_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    consecutive INTEGER NOT NULL DEFAULT 0,
    last_tick_at INTEGER
  );
  INSERT OR IGNORE INTO hold_counter (id, consecutive) VALUES (1, 0);
`);

const stmtMarkCooldown = db.prepare(
  `INSERT INTO pool_cooldowns (pool, last_action_at, last_action, last_tx)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(pool) DO UPDATE SET
     last_action_at = excluded.last_action_at,
     last_action    = excluded.last_action,
     last_tx        = excluded.last_tx`,
);
const stmtIsInCooldown = db.prepare(
  `SELECT last_action_at, last_action FROM pool_cooldowns WHERE pool = ?`,
);

export function markCooldown(pool: string, action: string, tx?: string): void {
  stmtMarkCooldown.run(pool.toLowerCase(), Date.now(), action, tx ?? null);
}

export function isInCooldown(
  pool: string,
  windowSeconds: number,
): { blocked: boolean; lastActionAt?: number; lastAction?: string; cooledUntil?: number } {
  const row = stmtIsInCooldown.get(pool.toLowerCase()) as
    | { last_action_at: number; last_action: string }
    | undefined;
  if (!row) return { blocked: false };
  const cooledUntil = row.last_action_at + windowSeconds * 1000;
  return {
    blocked: Date.now() < cooledUntil,
    lastActionAt: row.last_action_at,
    lastAction: row.last_action,
    cooledUntil,
  };
}

const stmtAppendTick = db.prepare(
  `INSERT OR REPLACE INTO pool_tick_history (pool, observed_at, tick) VALUES (?, ?, ?)`,
);
const stmtRecentTicks = db.prepare(
  `SELECT tick, observed_at FROM pool_tick_history WHERE pool = ?
   ORDER BY observed_at DESC LIMIT ?`,
);
const stmtTrimTicks = db.prepare(
  `DELETE FROM pool_tick_history WHERE pool = ? AND observed_at NOT IN
   (SELECT observed_at FROM pool_tick_history WHERE pool = ?
    ORDER BY observed_at DESC LIMIT ?)`,
);

export function appendTick(pool: string, tick: number, keep = 24): void {
  const key = pool.toLowerCase();
  stmtAppendTick.run(key, Date.now(), tick);
  stmtTrimTicks.run(key, key, keep);
}

export function recentTicks(pool: string, limit = 12): Array<{ tick: number; observedAt: number }> {
  const rows = stmtRecentTicks.all(pool.toLowerCase(), limit) as Array<{
    tick: number;
    observed_at: number;
  }>;
  return rows.map((r) => ({ tick: r.tick, observedAt: r.observed_at }));
}

const stmtBumpHold = db.prepare(
  `UPDATE hold_counter SET consecutive = consecutive + 1, last_tick_at = ? WHERE id = 1`,
);
const stmtResetHold = db.prepare(
  `UPDATE hold_counter SET consecutive = 0, last_tick_at = ? WHERE id = 1`,
);
const stmtReadHold = db.prepare(`SELECT consecutive FROM hold_counter WHERE id = 1`);

export function bumpHoldCounter(): number {
  stmtBumpHold.run(Date.now());
  return (stmtReadHold.get() as { consecutive: number }).consecutive;
}

export function resetHoldCounter(): void {
  stmtResetHold.run(Date.now());
}

export function readHoldCounter(): number {
  return (stmtReadHold.get() as { consecutive: number }).consecutive;
}
