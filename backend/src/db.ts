// B6 persistence — single-file sqlite (bun:sqlite, WAL mode).
//
// Holds every piece of mutable backend state that today only lives in RAM:
//   - agent ring + insertion-seq map (topics/agent.ts)
//   - indexer state: balances, lots, activity, fee_events, pool_orientation,
//     block_ts cache, first_deposit anchors, last_indexed_block cursor
//   - auth nonces (pre-consumption, plus consumed flag for blacklist)
//
// Design notes:
// - Bigints are stored as decimal strings. sqlite's INTEGER is 64-bit signed,
//   which is fine for USDC (6 dec) but tight for vault shares (18 dec); a TVL
//   of ~9.2e18 base units fits, but we'd rather not gamble on the headroom.
// - Every mutation is mirrored synchronously inside the indexer's per-chunk
//   transaction (so one fsync per chunk, not per event). Loads happen once at
//   boot, before the chain backfill resumes from the saved cursor.
// - No multi-process / concurrent-writer support — running two backends
//   against the same db file is undefined.
// - No schema migration framework — schema changes after B6 require explicit
//   ALTER TABLE statements added inline below the CREATE block.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { UserActivityRow } from "./types";

const DB_PATH = Bun.env.ALP_DB_PATH ?? "./data/alp.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

// Migrations — idempotent; run on every boot.
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_ring (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    recipient TEXT,                    -- NULL = vault-global broadcast
    msg_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_ring_id ON agent_ring(id);

  CREATE TABLE IF NOT EXISTS indexer_state (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS balances (
    wallet TEXT PRIMARY KEY,           -- lowercased
    shares_wei TEXT NOT NULL           -- bigint decimal
  );

  CREATE TABLE IF NOT EXISTS lots (
    wallet TEXT NOT NULL,
    lot_index INTEGER NOT NULL,
    ts_ms INTEGER NOT NULL,
    assets_in TEXT NOT NULL,
    shares_minted TEXT NOT NULL,
    shares_remaining TEXT NOT NULL,
    share_price_at_entry REAL NOT NULL,
    PRIMARY KEY (wallet, lot_index)
  );

  CREATE TABLE IF NOT EXISTS activity (
    wallet TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    token TEXT NOT NULL,
    ts TEXT NOT NULL,
    tx TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    PRIMARY KEY (wallet, id)
  );
  CREATE INDEX IF NOT EXISTS idx_activity_wallet_block ON activity(wallet, block_number DESC);

  CREATE TABLE IF NOT EXISTS fee_events (
    id TEXT PRIMARY KEY,               -- txHash:logIndex
    ts_ms INTEGER NOT NULL,
    usdc_amount TEXT NOT NULL,         -- bigint decimal (USDC base units)
    pool_key TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fee_events_ts ON fee_events(ts_ms);

  CREATE TABLE IF NOT EXISTS pool_orientation (
    pool_key TEXT PRIMARY KEY,
    non_base_token TEXT NOT NULL,
    usdc_is_token0 INTEGER NOT NULL    -- 0 or 1
  );

  CREATE TABLE IF NOT EXISTS block_ts (
    block_number INTEGER PRIMARY KEY,
    ts_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS first_deposit (
    wallet TEXT PRIMARY KEY,
    ts_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce TEXT PRIMARY KEY,
    issued_at_ms INTEGER NOT NULL,
    consumed INTEGER NOT NULL          -- 0 or 1
  );

  CREATE TABLE IF NOT EXISTS sherpa_usage (
    wallet TEXT NOT NULL,              -- lowercased
    day TEXT NOT NULL,                 -- UTC YYYY-MM-DD
    count INTEGER NOT NULL,            -- messages sent on `day` so far
    last_msg_ms INTEGER NOT NULL,      -- epoch ms of most recent send
    PRIMARY KEY (wallet, day)
  );
`);

// ----------------------------------------------------------- prepared stmts

// indexer_state — generic key/value
const stmtIndexerStateGet    = db.query<{ v: string }, [string]>("SELECT v FROM indexer_state WHERE k = ?");
const stmtIndexerStateUpsert = db.query<unknown, [string, string]>(
  "INSERT INTO indexer_state(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
);

// balances
const stmtBalanceUpsert      = db.query<unknown, [string, string]>(
  "INSERT INTO balances(wallet, shares_wei) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET shares_wei = excluded.shares_wei",
);
const stmtBalanceDelete      = db.query<unknown, [string]>("DELETE FROM balances WHERE wallet = ?");
const stmtBalanceLoadAll     = db.query<{ wallet: string; shares_wei: string }, []>("SELECT wallet, shares_wei FROM balances");

// lots
const stmtLotInsert          = db.query<unknown, [string, number, number, string, string, string, number]>(
  "INSERT INTO lots(wallet, lot_index, ts_ms, assets_in, shares_minted, shares_remaining, share_price_at_entry) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const stmtLotUpdateRemaining = db.query<unknown, [string, string, number]>(
  "UPDATE lots SET shares_remaining = ? WHERE wallet = ? AND lot_index = ?",
);
const stmtLotDelete          = db.query<unknown, [string, number]>("DELETE FROM lots WHERE wallet = ? AND lot_index = ?");
const stmtLotsByWallet       = db.query<
  { wallet: string; lot_index: number; ts_ms: number; assets_in: string; shares_minted: string; shares_remaining: string; share_price_at_entry: number },
  []
>("SELECT wallet, lot_index, ts_ms, assets_in, shares_minted, shares_remaining, share_price_at_entry FROM lots ORDER BY wallet, lot_index ASC");
const stmtLotsMaxIndex       = db.query<{ wallet: string; max_idx: number }, []>(
  "SELECT wallet, MAX(lot_index) AS max_idx FROM lots GROUP BY wallet",
);

// activity
const stmtActivityInsert     = db.query<unknown, [string, string, string, number, string, string, string, number]>(
  "INSERT OR IGNORE INTO activity(wallet, id, kind, amount, token, ts, tx, block_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
const stmtActivityTrim       = db.query<unknown, [string, string]>(
  "DELETE FROM activity WHERE wallet = ? AND id NOT IN (SELECT id FROM activity WHERE wallet = ? ORDER BY block_number DESC, rowid DESC LIMIT 100)",
);
const stmtActivityByWallet   = db.query<
  { id: string; kind: string; amount: number; token: string; ts: string; tx: string },
  [string]
>("SELECT id, kind, amount, token, ts, tx FROM activity WHERE wallet = ? ORDER BY block_number DESC, rowid DESC LIMIT 100");
const stmtActivityWallets    = db.query<{ wallet: string }, []>("SELECT DISTINCT wallet FROM activity");

// fee_events
const stmtFeeEventInsert     = db.query<unknown, [string, number, string, string]>(
  "INSERT OR IGNORE INTO fee_events(id, ts_ms, usdc_amount, pool_key) VALUES (?, ?, ?, ?)",
);
const stmtFeeEventPrune      = db.query<unknown, [number]>("DELETE FROM fee_events WHERE ts_ms < ?");
const stmtFeeEventLoadAll    = db.query<
  { id: string; ts_ms: number; usdc_amount: string; pool_key: string },
  []
>("SELECT id, ts_ms, usdc_amount, pool_key FROM fee_events ORDER BY ts_ms ASC");

// pool_orientation
const stmtPoolUpsert         = db.query<unknown, [string, string, number]>(
  "INSERT INTO pool_orientation(pool_key, non_base_token, usdc_is_token0) VALUES (?, ?, ?) ON CONFLICT(pool_key) DO UPDATE SET non_base_token = excluded.non_base_token, usdc_is_token0 = excluded.usdc_is_token0",
);
const stmtPoolLoadAll        = db.query<
  { pool_key: string; non_base_token: string; usdc_is_token0: number },
  []
>("SELECT pool_key, non_base_token, usdc_is_token0 FROM pool_orientation");

// block_ts
const stmtBlockTsUpsert      = db.query<unknown, [number, number]>(
  "INSERT INTO block_ts(block_number, ts_ms) VALUES (?, ?) ON CONFLICT(block_number) DO UPDATE SET ts_ms = excluded.ts_ms",
);
const stmtBlockTsLoadAll     = db.query<{ block_number: number; ts_ms: number }, []>(
  "SELECT block_number, ts_ms FROM block_ts",
);

// first_deposit
const stmtFirstDepositUpsert = db.query<unknown, [string, number]>(
  "INSERT INTO first_deposit(wallet, ts_ms) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET ts_ms = excluded.ts_ms",
);
const stmtFirstDepositDelete = db.query<unknown, [string]>("DELETE FROM first_deposit WHERE wallet = ?");
const stmtFirstDepositLoad   = db.query<{ wallet: string; ts_ms: number }, []>(
  "SELECT wallet, ts_ms FROM first_deposit",
);

// agent_ring
const stmtAgentRingInsert    = db.query<unknown, [number, string, string | null, string]>(
  "INSERT INTO agent_ring(seq, id, recipient, msg_json) VALUES (?, ?, ?, ?)",
);
const stmtAgentRingDelete    = db.query<unknown, [number]>("DELETE FROM agent_ring WHERE seq = ?");
const stmtAgentRingLoadAll   = db.query<
  { seq: number; id: string; recipient: string | null; msg_json: string },
  []
>("SELECT seq, id, recipient, msg_json FROM agent_ring ORDER BY seq ASC");

// sherpa_usage — daily counter + cooldown tracking per wallet
const stmtSherpaUsageGet     = db.query<{ count: number; last_msg_ms: number }, [string, string]>(
  "SELECT count, last_msg_ms FROM sherpa_usage WHERE wallet = ? AND day = ?",
);
const stmtSherpaUsageUpsert  = db.query<unknown, [string, string, number, number]>(
  "INSERT INTO sherpa_usage(wallet, day, count, last_msg_ms) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(wallet, day) DO UPDATE SET count = excluded.count, last_msg_ms = excluded.last_msg_ms",
);

// auth_nonces
const stmtAuthNonceInsert    = db.query<unknown, [string, number]>(
  "INSERT OR REPLACE INTO auth_nonces(nonce, issued_at_ms, consumed) VALUES (?, ?, 0)",
);
const stmtAuthNonceConsume   = db.query<unknown, [string]>(
  "UPDATE auth_nonces SET consumed = 1 WHERE nonce = ?",
);
const stmtAuthNonceGet       = db.query<{ issued_at_ms: number; consumed: number }, [string]>(
  "SELECT issued_at_ms, consumed FROM auth_nonces WHERE nonce = ?",
);
const stmtAuthNoncePrune     = db.query<unknown, [number]>(
  "DELETE FROM auth_nonces WHERE issued_at_ms < ?",
);
const stmtAuthNonceLoadActive = db.query<
  { nonce: string; issued_at_ms: number; consumed: number },
  [number]
>("SELECT nonce, issued_at_ms, consumed FROM auth_nonces WHERE issued_at_ms >= ?");

// ----------------------------------------------------- typed helpers

// indexer_state
export function readIndexerState(key: string): string | null {
  const row = stmtIndexerStateGet.get(key);
  return row ? row.v : null;
}
export function upsertIndexerState(key: string, value: string): void {
  stmtIndexerStateUpsert.run(key, value);
}

// balances
export function upsertBalance(wallet: string, sharesWei: bigint): void {
  stmtBalanceUpsert.run(wallet, sharesWei.toString());
}
export function deleteBalance(wallet: string): void {
  stmtBalanceDelete.run(wallet);
}
export function loadAllBalances(): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const row of stmtBalanceLoadAll.all()) {
    out.set(row.wallet, BigInt(row.shares_wei));
  }
  return out;
}

// lots
export type LotRow = {
  lotIndex: number;
  tsMs: number;
  assetsIn: bigint;
  sharesMinted: bigint;
  sharesRemaining: bigint;
  sharePriceAtEntry: number;
};
export function appendLot(
  wallet: string,
  lotIndex: number,
  tsMs: number,
  assetsIn: bigint,
  sharesMinted: bigint,
  sharesRemaining: bigint,
  sharePriceAtEntry: number,
): void {
  stmtLotInsert.run(
    wallet, lotIndex, tsMs,
    assetsIn.toString(), sharesMinted.toString(), sharesRemaining.toString(),
    sharePriceAtEntry,
  );
}
export function updateLotRemaining(wallet: string, lotIndex: number, sharesRemaining: bigint): void {
  stmtLotUpdateRemaining.run(sharesRemaining.toString(), wallet, lotIndex);
}
export function deleteLot(wallet: string, lotIndex: number): void {
  stmtLotDelete.run(wallet, lotIndex);
}
export function loadAllLots(): Map<string, LotRow[]> {
  const out = new Map<string, LotRow[]>();
  for (const row of stmtLotsByWallet.all()) {
    let list = out.get(row.wallet);
    if (!list) { list = []; out.set(row.wallet, list); }
    list.push({
      lotIndex: row.lot_index,
      tsMs: row.ts_ms,
      assetsIn: BigInt(row.assets_in),
      sharesMinted: BigInt(row.shares_minted),
      sharesRemaining: BigInt(row.shares_remaining),
      sharePriceAtEntry: row.share_price_at_entry,
    });
  }
  return out;
}
// Per-wallet "next lot index" — max(lot_index)+1 across surviving lot rows.
// Wallets whose lots are all consumed simply absent → caller treats as 0.
export function loadNextLotIndices(): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of stmtLotsMaxIndex.all()) {
    out.set(row.wallet, row.max_idx + 1);
  }
  return out;
}

// activity
export function appendActivity(
  wallet: string,
  row: UserActivityRow,
  blockNumber: bigint,
): void {
  stmtActivityInsert.run(
    wallet, row.id, row.kind, row.amount, row.token, row.ts, row.tx,
    Number(blockNumber),
  );
}
export function trimActivity(wallet: string): void {
  stmtActivityTrim.run(wallet, wallet);
}
export function loadActivityForWallet(wallet: string): UserActivityRow[] {
  return stmtActivityByWallet.all(wallet).map((r) => ({
    id: r.id,
    kind: r.kind as UserActivityRow["kind"],
    amount: r.amount,
    token: r.token as UserActivityRow["token"],
    ts: r.ts,
    tx: r.tx,
  }));
}
export function loadAllActivityWallets(): string[] {
  return stmtActivityWallets.all().map((r) => r.wallet);
}

// fee_events
export function insertFeeEvent(
  id: string, tsMs: number, usdcAmount: bigint, poolKey: string,
): void {
  stmtFeeEventInsert.run(id, tsMs, usdcAmount.toString(), poolKey);
}
export function pruneFeeEventsBefore(cutoffMs: number): void {
  stmtFeeEventPrune.run(cutoffMs);
}
export type FeeEventRow = { id: string; tsMs: number; usdcAmount: bigint; poolKey: `0x${string}` };
export function loadAllFeeEvents(): FeeEventRow[] {
  return stmtFeeEventLoadAll.all().map((r) => ({
    id: r.id,
    tsMs: r.ts_ms,
    usdcAmount: BigInt(r.usdc_amount),
    poolKey: r.pool_key as `0x${string}`,
  }));
}

// pool_orientation
export function upsertPoolOrientation(
  poolKey: string, nonBaseToken: string, usdcIsToken0: boolean,
): void {
  stmtPoolUpsert.run(poolKey, nonBaseToken, usdcIsToken0 ? 1 : 0);
}
export type PoolOrientRow = { poolKey: `0x${string}`; nonBaseToken: `0x${string}`; usdcIsToken0: boolean };
export function loadAllPoolOrientations(): PoolOrientRow[] {
  return stmtPoolLoadAll.all().map((r) => ({
    poolKey: r.pool_key as `0x${string}`,
    nonBaseToken: r.non_base_token as `0x${string}`,
    usdcIsToken0: r.usdc_is_token0 === 1,
  }));
}

// block_ts
export function upsertBlockTs(blockNumber: bigint, tsMs: number): void {
  stmtBlockTsUpsert.run(Number(blockNumber), tsMs);
}
export function loadAllBlockTs(): Map<bigint, number> {
  const out = new Map<bigint, number>();
  for (const row of stmtBlockTsLoadAll.all()) {
    out.set(BigInt(row.block_number), row.ts_ms);
  }
  return out;
}

// first_deposit
export function upsertFirstDeposit(wallet: string, tsMs: number): void {
  stmtFirstDepositUpsert.run(wallet, tsMs);
}
export function deleteFirstDeposit(wallet: string): void {
  stmtFirstDepositDelete.run(wallet);
}
export function loadAllFirstDeposits(): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of stmtFirstDepositLoad.all()) {
    out.set(row.wallet, row.ts_ms);
  }
  return out;
}

// agent_ring
export type AgentRingRow = { seq: number; id: string; recipient: string | null; msgJson: string };
export function appendAgentRingEntry(
  seq: number, id: string, recipient: string | null, msgJson: string,
): void {
  stmtAgentRingInsert.run(seq, id, recipient, msgJson);
}
export function deleteAgentRingEntry(seq: number): void {
  stmtAgentRingDelete.run(seq);
}
export function loadAllAgentRing(): AgentRingRow[] {
  return stmtAgentRingLoadAll.all().map((r) => ({
    seq: r.seq,
    id: r.id,
    recipient: r.recipient,
    msgJson: r.msg_json,
  }));
}

// sherpa_usage
export type SherpaUsageRow = { count: number; lastMsgMs: number };
export function readSherpaUsage(wallet: string, day: string): SherpaUsageRow | null {
  const row = stmtSherpaUsageGet.get(wallet, day);
  if (!row) return null;
  return { count: row.count, lastMsgMs: row.last_msg_ms };
}
export function writeSherpaUsage(wallet: string, day: string, count: number, lastMsgMs: number): void {
  stmtSherpaUsageUpsert.run(wallet, day, count, lastMsgMs);
}

// auth_nonces
export function insertAuthNonce(nonce: string, issuedAtMs: number): void {
  stmtAuthNonceInsert.run(nonce, issuedAtMs);
}
export function consumeAuthNonceDb(nonce: string): boolean {
  // Returns true iff the row exists, was unconsumed, and is now flipped.
  const row = stmtAuthNonceGet.get(nonce);
  if (!row || row.consumed === 1) return false;
  stmtAuthNonceConsume.run(nonce);
  return true;
}
export function pruneAuthNoncesBefore(cutoffMs: number): void {
  stmtAuthNoncePrune.run(cutoffMs);
}
export type AuthNonceRow = { nonce: string; issuedAtMs: number; consumed: boolean };
export function loadActiveAuthNonces(cutoffMs: number): AuthNonceRow[] {
  return stmtAuthNonceLoadActive.all(cutoffMs).map((r) => ({
    nonce: r.nonce,
    issuedAtMs: r.issued_at_ms,
    consumed: r.consumed === 1,
  }));
}

// Wrap a synchronous block in a single sqlite transaction. One fsync per
// outer call regardless of how many statements run inside.
export function withTransaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}
