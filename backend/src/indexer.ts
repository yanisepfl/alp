// Vault event indexer. In-memory state derived from event streams on the
// deployed ALPVault:
//
// - ERC20 Transfer (the vault's own share token) → live wallet balances
// - FeesCollected (vault) → 30d realised fee revenue + agent-action dispatch
// - PoolTracked (vault) → poolKey orientation
// - Deposit (ERC4626) → per-wallet basis lots, activity rows
// - Withdraw (ERC4626) → FIFO lot consumption, activity rows
// - LiquidityAdded / LiquidityRemoved / Swapped / PositionTracked /
//   PositionUntracked → agent-action dispatch
//
// Drives four VaultSnapshot fields:
//   users = wallets currently holding > 0 shares
//   basketEarned30d = USD fees realised in the last 30 days (USDC side only)
//   basketApr = (basketEarned30d / tvl_usd) * (365 / 30) * 100
//   apr30d = 30 EOD APR closes
//
// And the entire UserSnapshot:
//   position.{shares,valueUsd,costBasisSharePrice,totalDepositedUsd,...}
//   activity[] most-recent-first, capped at 100, ids = txHash:logIndex
//
// Accounting: WAVG entry across deposits, FIFO consumption on withdraws.
// Server is authoritative — frontend never recomputes any field.
//
// Limitations:
// - Peer-to-peer share transfers (Transfer where from!=0x0 AND to!=0x0)
//   update `balances` but do NOT mutate lot lists on either side. A warning
//   is logged per peer transfer encountered.
// - Only the USDC side of FeesCollected is tracked.
// - No reorg handling; Base soft-finalises at ~2 blocks.
//
// Every in-memory mutation is mirrored synchronously into the sqlite store
// at ./data/alps.sqlite (path overridable via ALPS_DB_PATH). On boot,
// `startIndexer` rehydrates state from disk, then resumes backfill from the
// persisted `last_indexed_block` cursor.

import { parseAbiItem, type Log, type PublicClient } from "viem";
import { SHARE_UNIT, USDC_BASE_ADDRESS } from "./chain";
import { notifyKeeperReact } from "./keeperReact";
import type { UserActivityRow, UserSnapshot } from "./types";
import {
 appendActivity, appendLot, deleteFirstDeposit, deleteLot, insertFeeEvent,
 loadAllActivityWallets, loadActivityForWallet, loadAllBalances,
 loadAllBlockTs, loadAllFirstDeposits, loadAllFeeEvents, loadAllLots,
 loadAllPoolOrientations, loadNextLotIndices, pruneFeeEventsBefore,
 readIndexerState, trimActivity, updateLotRemaining, upsertBalance,
 upsertBlockTs, upsertFirstDeposit, upsertIndexerState, upsertPoolOrientation,
 withTransaction, deleteBalance,
} from "./db";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const FEES_COLLECTED_EVENT = parseAbiItem("event FeesCollected(bytes32 indexed poolKey, uint256 positionId, uint256 amount0, uint256 amount1)");
const POOL_TRACKED_EVENT = parseAbiItem("event PoolTracked(bytes32 indexed poolKey, address indexed nonBaseToken)");
const DEPOSIT_EVENT = parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)");
const WITHDRAW_EVENT = parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)");
const LIQUIDITY_ADDED_EVENT = parseAbiItem("event LiquidityAdded(bytes32 indexed poolKey, uint256 positionId, uint256 amount0Used, uint256 amount1Used)");
const LIQUIDITY_REMOVED_EVENT = parseAbiItem("event LiquidityRemoved(bytes32 indexed poolKey, uint256 positionId, uint256 amount0Out, uint256 amount1Out)");
const SWAPPED_EVENT = parseAbiItem("event Swapped(bytes32 indexed poolKey, address indexed tokenIn, uint256 amountIn, uint256 amountOut)");
const POSITION_TRACKED_EVENT = parseAbiItem("event PositionTracked(bytes32 indexed poolKey, uint256 indexed positionId)");
const POSITION_UNTRACKED_EVENT = parseAbiItem("event PositionUntracked(bytes32 indexed poolKey, uint256 indexed positionId)");

const DAY_MS = 86_400_000;
const APR_HISTORY_LEN = 30;
const FEE_RETENTION_MS = 31 * DAY_MS; // keep one day of slack past the 30-day window
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_BACKFILL_DEPTH = 100_000n; // ~2.3 days on Base
const DEFAULT_CHUNK_BLOCKS = 10_000n;

// id = `${txHash}:${logIndex}` so persisted inserts dedupe across the
// boot-load → backfill seam.
type FeeEvent = { id: string; tsMs: number; usdcAmount: bigint; poolKey: `0x${string}` };
type PoolMeta = { nonBaseToken: `0x${string}`; usdcIsToken0: boolean };

// Agent-action stream. topics/agent.ts registers a watcher via
// subscribeAgentActions and translates each event into a WireMessage with
// the real on-chain tx hash. Action WireMessages are never fabricated —
// every dispatch corresponds to a log the indexer just folded.
export type AgentActionEvent =
 | { kind: "liquidity_added"; poolKey: `0x${string}`; positionId: bigint; amount0: bigint; amount1: bigint; tx: `0x${string}`; blockNumber: bigint; logIndex: number; blockTs: number }
 | { kind: "liquidity_removed"; poolKey: `0x${string}`; positionId: bigint; amount0: bigint; amount1: bigint; tx: `0x${string}`; blockNumber: bigint; logIndex: number; blockTs: number }
 | { kind: "swapped"; poolKey: `0x${string}`; tokenIn: `0x${string}`; amountIn: bigint; amountOut: bigint; tx: `0x${string}`; blockNumber: bigint; logIndex: number; blockTs: number }
 | { kind: "fees_collected"; poolKey: `0x${string}`; positionId: bigint; amount0: bigint; amount1: bigint; tx: `0x${string}`; blockNumber: bigint; logIndex: number; blockTs: number }
 | { kind: "position_tracked"; poolKey: `0x${string}`; positionId: bigint; tx: `0x${string}`; blockNumber: bigint; logIndex: number; blockTs: number }
 | { kind: "position_untracked"; poolKey: `0x${string}`; positionId: bigint; tx: `0x${string}`; blockNumber: bigint; logIndex: number; blockTs: number };

// Per-wallet basis lot. tsMs anchors firstDepositTs / "days held";
// sharesRemaining is FIFO-consumed by withdraws (lot dropped at zero).
// lotIndex is the lifetime-monotonic index used as the sqlite primary key
// (alongside wallet). Stays put for the lot's life — gaps left by FIFO
// consumption never get reused, so loading by ORDER BY lot_index ASC
// preserves FIFO order.
type Lot = {
 lotIndex: number;
 tsMs: number;
 assetsIn: bigint; // USDC base units (6 dec)
 sharesMinted: bigint; // share base units (18 dec) — original size
 sharesRemaining: bigint; // FIFO-consumed; reaches 0 then lot is dropped
 sharePriceAtEntry: number; // (assetsIn/1e6) / (sharesMinted/SHARE_UNIT); cached at ingest
};

const ACTIVITY_CAP = 100;

let lastIndexedBlock: bigint | null = null;
const balances = new Map<string, bigint>();
const feeEvents: FeeEvent[] = [];
const poolOrientation = new Map<`0x${string}`, PoolMeta>();

// Per-wallet (lower-cased) state.
const lots = new Map<string, Lot[]>();
const activity = new Map<string, UserActivityRow[]>();
const firstDepositTs = new Map<string, number>();
// Per-wallet next lot index (max(lot_index)+1 over surviving rows at boot,
// then incremented in-process on each new Deposit). Wallets whose lots are
// all consumed are absent → fresh push uses 0.
const nextLotIndex = new Map<string, number>();
// Tx-driven re-emit hooks. topics/user.ts registers a callback per cid.
const walletWatchers = new Map<string, Set<() => void>>();

// Agent-action watchers. Fired synchronously inside applyLogs so the agent
// ring's seq ordering matches chain (block, logIndex) order.
const agentActionWatchers = new Set<(evt: AgentActionEvent) => void>();

// Process-lifetime block timestamp cache. Populated by a per-chunk batch
// fetch in applyLogs (concurrency 5 to respect public Base RPC) and reused
// across chunks within the same boot. Falls back to "now" on a failed
// getBlock so events still land in today's bucket.
const blockTsCache = new Map<bigint, number>();
const BLOCK_TS_CONCURRENCY = 5;

let started = false;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
// Flips to true once startIndexer's backfill completes. Until then we
// suppress keeper /react notifications so historical Deposit/Withdraw
// events from the cold-start replay don't trigger phantom reactions.
let liveTailActive = false;

// ---------------------------------------------------------------------- API

export async function startIndexer(
 client: PublicClient,
 vaultAddr: `0x${string}`,
): Promise<void> {
 if (started) return;
 started = true;

 // Rehydrate from sqlite so all in-memory state is populated before
 // backfill runs. Backfill then only re-applies new events (cursor+1 → head).
 loadAllFromDb();

 const head = await client.getBlockNumber();
 const cursorRaw = readIndexerState("last_indexed_block");
 let startBlock: bigint;
 if (cursorRaw !== null && /^\d+$/.test(cursorRaw)) {
 startBlock = BigInt(cursorRaw) + 1n;
 const gap = head > BigInt(cursorRaw) ? head - BigInt(cursorRaw) : 0n;
 if (gap > DEFAULT_BACKFILL_DEPTH) {
 console.warn(`[indexer] gap of ${gap} blocks since last cursor; backfill may take a while`);
 }
 } else {
 const fromEnv = Bun.env.VAULT_DEPLOY_BLOCK;
 startBlock = fromEnv && /^\d+$/.test(fromEnv)
 ? BigInt(fromEnv)
 : (head > DEFAULT_BACKFILL_DEPTH ? head - DEFAULT_BACKFILL_DEPTH : 0n);
 }
 const chunk = Bun.env.LOG_CHUNK_BLOCKS && /^\d+$/.test(Bun.env.LOG_CHUNK_BLOCKS)
 ? BigInt(Bun.env.LOG_CHUNK_BLOCKS)
 : DEFAULT_CHUNK_BLOCKS;

 console.log(`[indexer] boot from sqlite: ${balances.size} balances, ${feeEvents.length} fee events, ${poolOrientation.size} pools, ${lots.size} wallets-with-lots, cursor=${cursorRaw ?? "<none>"}`);

 if (head >= startBlock) {
 console.log(`[indexer] backfill start=${startBlock} head=${head} chunk=${chunk}`);
 await backfill(client, vaultAddr, startBlock, head, chunk);
 } else {
 console.log(`[indexer] no backfill needed (cursor ${cursorRaw} >= head ${head})`);
 }
 lastIndexedBlock = head;
 upsertIndexerState("last_indexed_block", head.toString());
 // Backfill done. From here on, every Deposit/Withdraw the live tail
 // sees is a real-time user flow and gets forwarded to the keeper for
 // an immediate /react. During backfill we kept this off so historical
 // events don't replay reactions on every boot.
 liveTailActive = true;

 const liveUsers = countLiveHolders();
 console.log(`[indexer] boot complete: ${liveUsers} users, ${feeEvents.length} fee events, ${poolOrientation.size} pools tracked`);

 if (!pruneTimer) {
 pruneTimer = setInterval(pruneStaleFees, PRUNE_INTERVAL_MS);
 }
}

// Boot rehydration. Reads every persisted table into the in-memory
// shadows. Block-ts cache stores seconds (matching `getBlock().timestamp`
// semantics); db stores ms.
function loadAllFromDb(): void {
 for (const [w, v] of loadAllBalances()) balances.set(w, v);

 for (const [w, list] of loadAllLots()) {
 lots.set(w, list.map((r) => ({
 lotIndex: r.lotIndex,
 tsMs: r.tsMs,
 assetsIn: r.assetsIn,
 sharesMinted: r.sharesMinted,
 sharesRemaining: r.sharesRemaining,
 sharePriceAtEntry: r.sharePriceAtEntry,
 })));
 }
 for (const [w, n] of loadNextLotIndices()) nextLotIndex.set(w, n);

 for (const w of loadAllActivityWallets()) {
 activity.set(w, loadActivityForWallet(w));
 }

 for (const fe of loadAllFeeEvents()) feeEvents.push(fe);

 for (const o of loadAllPoolOrientations()) {
 poolOrientation.set(o.poolKey, { nonBaseToken: o.nonBaseToken, usdcIsToken0: o.usdcIsToken0 });
 }

 for (const [b, ms] of loadAllBlockTs()) blockTsCache.set(b, Math.floor(ms / 1000));

 for (const [w, ms] of loadAllFirstDeposits()) firstDepositTs.set(w, ms);
}

// Called from the vault chain reader's 5s tick loop, after each successful
// getBlockNumber. Pulls logs in (lastIndexedBlock, head] for all three event
// types and folds them into in-memory state.
export async function indexUpToHead(
 client: PublicClient,
 vaultAddr: `0x${string}`,
 head: bigint,
): Promise<void> {
 if (lastIndexedBlock === null || head <= lastIndexedBlock) return;
 const from = lastIndexedBlock + 1n;
 let logs: Log[];
 try {
 logs = await fetchAllEventLogs(client, vaultAddr, from, head);
 } catch (e) {
 console.warn(`[indexer] incremental fetch failed (${from}→${head}): ${e instanceof Error ? e.message : String(e)}`);
 return;
 }
 // Always advance the persisted cursor — even an empty chunk — so a quiet
 // vault doesn't re-fetch the same range every boot.
 await applyLogs(client, logs, head);
 if (logs.length > 0) console.log(`[indexer] +${logs.length} events at block ${head}`);
 lastIndexedBlock = head;
}

export function getVaultStats(tvlMillions: number, tvl30dMillions: number[]): {
 users: number;
 earned30dUsd: number;
 apr: number;
 apr30d: number[];
} {
 const users = countLiveHolders();
 const now = Date.now();
 const cutoff = now - 30 * DAY_MS;

 let earned30dUsd = 0;
 for (const fee of feeEvents) {
 if (fee.tsMs >= cutoff) earned30dUsd += Number(fee.usdcAmount) / 1e6;
 }

 const apr = aprFor(earned30dUsd, tvlMillions, 30);

 const apr30d: number[] = new Array(APR_HISTORY_LEN).fill(0);
 const dayBucket = Math.floor(now / DAY_MS);
 for (let i = 0; i < APR_HISTORY_LEN; i++) {
 const dayStart = (dayBucket - (APR_HISTORY_LEN - 1 - i)) * DAY_MS;
 const dayEnd = dayStart + DAY_MS;
 let dailyUsd = 0;
 for (const fee of feeEvents) {
 if (fee.tsMs >= dayStart && fee.tsMs < dayEnd) {
 dailyUsd += Number(fee.usdcAmount) / 1e6;
 }
 }
 const dayTvl = tvl30dMillions[i] ?? tvlMillions;
 apr30d[i] = aprFor(dailyUsd, dayTvl, 1);
 }

 // When the per-day buckets are all zero but the trailing 30d headline
 // `apr` is non-zero (deploy younger than a UTC day, so only today has
 // events and a single-day point annualises wildly), backfill all 30 slots
 // with the headline value so the sparkline reads as a flat line at the
 // realised APR rather than zero.
 let dailyMax = 0;
 for (const v of apr30d) if (v > dailyMax) dailyMax = v;
 if (dailyMax === 0 && apr > 0) {
 for (let i = 0; i < apr30d.length; i++) apr30d[i] = apr;
 }

 return {
 users,
 earned30dUsd: round(earned30dUsd, 2),
 apr: round(apr, 2),
 apr30d: apr30d.map((v) => round(v, 2)),
 };
}

// Sum of USDC-side fee revenue (USD, not base units) for a single poolKey
// across the trailing 30d window. Returns 0 for unknown pools.
export function getPoolEarned30dUsd(poolKey: `0x${string}`): number {
 const cutoff = Date.now() - 30 * DAY_MS;
 let usd = 0;
 for (const fee of feeEvents) {
 if (fee.poolKey === poolKey && fee.tsMs >= cutoff) {
 usd += Number(fee.usdcAmount) / 1e6;
 }
 }
 return usd;
}

// Per-wallet position + activity snapshot. Server is authoritative for
// every numeric field; FE renders verbatim.
export function getUserSnapshot(wallet: string, sharePriceNow: number): UserSnapshot {
 const w = wallet.toLowerCase();
 const walletLots = lots.get(w) ?? [];
 const balance = balances.get(w) ?? 0n;
 const acts = activity.get(w) ?? [];
 const ts = new Date().toISOString();

 // No deposits *and* no shares → fresh wallet.
 if (walletLots.length === 0 && balance === 0n) {
 return { wallet, position: null, activity: acts.slice(), ts };
 }

 // Defensive: shares without a lot list. Requires an untracked peer
 // transfer (see header limitation). Emit a position with zeroed basis
 // rather than crashing or returning null.
 if (walletLots.length === 0) {
 console.warn(`[indexer] wallet ${w} has shares=${balance} but no basis lots — peer transfer? returning zero-basis position`);
 const sharesFloat = Number(balance) / Number(SHARE_UNIT);
 return {
 wallet,
 position: {
 shares: balance.toString(),
 valueUsd: sharesFloat * sharePriceNow,
 costBasisSharePrice: 0,
 totalDepositedUsd: 0,
 firstDepositTs: ts,
 pnlUsd: 0,
 pnlPct: 0,
 realizedApyPct: 0,
 },
 activity: acts.slice(),
 ts,
 };
 }

 // Basis remaining after FIFO consumption: each lot contributes assetsIn ×
 // (sharesRemaining / sharesMinted). A fully-consumed lot contributes 0; a
 // half-consumed lot contributes half its original USDC.
 const totalDepositedUsd = walletLots.reduce(
 (s, l) => s + (Number(l.assetsIn) / 1e6) * (Number(l.sharesRemaining) / Number(l.sharesMinted)),
 0,
 );

 // Share-weighted WAVG of sharePriceAtEntry across remaining lots.
 const totalRemainingShares = walletLots.reduce((s, l) => s + l.sharesRemaining, 0n);
 const costBasisSharePrice = totalRemainingShares > 0n
 ? walletLots.reduce(
 (s, l) => s + l.sharePriceAtEntry * (Number(l.sharesRemaining) / Number(totalRemainingShares)),
 0,
 )
 : 0;

 const sharesFloat = Number(balance) / Number(SHARE_UNIT);
 const valueUsd = sharesFloat * sharePriceNow;
 const pnlUsd = valueUsd - totalDepositedUsd;
 // pnlPct is "as percent of active basis cost" (i.e. basis remaining
 // after FIFO consumption).
 const pnlPct = totalDepositedUsd > 0 ? (pnlUsd / totalDepositedUsd) * 100 : 0;

 const fts = firstDepositTs.get(w);
 const firstDepositIso = fts ? new Date(fts).toISOString() : ts;
 const daysHeld = fts ? Math.max((Date.now() - fts) / 86_400_000, 0) : 0;
 // realizedApyPct is meaningless before a full day has elapsed since first
 // deposit — return 0 rather than a wildly extrapolated annual rate.
 const realizedApyPct = totalDepositedUsd > 0 && daysHeld >= 1
 ? (pnlUsd / totalDepositedUsd) * (365 / daysHeld) * 100
 : 0;

 return {
 wallet,
 position: {
 shares: balance.toString(),
 valueUsd,
 costBasisSharePrice,
 totalDepositedUsd,
 firstDepositTs: firstDepositIso,
 pnlUsd,
 pnlPct,
 realizedApyPct,
 },
 activity: acts.slice(),
 ts,
 };
}

// Lightweight read for the share-price-driven re-emit path: avoids
// rebuilding the whole snapshot just to diff valueUsd.
export function getWalletShares(wallet: string): bigint {
 return balances.get(wallet.toLowerCase()) ?? 0n;
}

// Indexer cursor for /health. Returns null in mock mode or before the
// first indexUpToHead tick lands.
export function getLastIndexedBlock(): bigint | null {
 return lastIndexedBlock;
}

// Chain-action subscription. The indexer fires the callback for every
// LiquidityAdded / LiquidityRemoved / Swapped / FeesCollected /
// PositionTracked / PositionUntracked event ingested, in (block, logIndex)
// order. Returns an unsubscribe fn.
export function subscribeAgentActions(cb: (evt: AgentActionEvent) => void): () => void {
 agentActionWatchers.add(cb);
 return () => { agentActionWatchers.delete(cb); };
}

// Pool orientation lookup for the agent topic. Returns null when the
// indexer has not yet seen a PoolTracked event for this key.
export function getPoolOrientation(
 poolKey: `0x${string}`,
): { nonBaseToken: `0x${string}`; usdcIsToken0: boolean } | null {
 return poolOrientation.get(poolKey) ?? null;
}

// Tx-driven re-emit subscription. Returns an unsubscribe fn. A connection
// registers once per (cid, wallet) on user-topic subscribe.
export function subscribeUserUpdates(wallet: string, cb: () => void): () => void {
 const w = wallet.toLowerCase();
 let set = walletWatchers.get(w);
 if (!set) {
 set = new Set();
 walletWatchers.set(w, set);
 }
 set.add(cb);
 return () => {
 const s = walletWatchers.get(w);
 if (!s) return;
 s.delete(cb);
 if (s.size === 0) walletWatchers.delete(w);
 };
}

// ----------------------------------------------------------------- Internals

function countLiveHolders(): number {
 let n = 0;
 for (const bal of balances.values()) if (bal > 0n) n++;
 return n;
}

// periodDays === 30 → annualised over 30d; periodDays === 1 → daily APR.
function aprFor(usdEarned: number, tvlMillions: number, periodDays: number): number {
 // Clamp denominator: < $1k TVL is noise on a tiny vault — emit 0.
 if (!isFinite(tvlMillions) || tvlMillions < 0.001) return 0;
 const tvlUsd = tvlMillions * 1e6;
 const annualisationFactor = 365 / periodDays;
 return (usdEarned / tvlUsd) * annualisationFactor * 100;
}

function round(n: number, d: number): number { return Number(n.toFixed(d)); }

function pruneStaleFees(): void {
 const cutoff = Date.now() - FEE_RETENTION_MS;
 const before = feeEvents.length;
 // In-place filter — don't assume sortedness across incremental ticks.
 let w = 0;
 for (let r = 0; r < feeEvents.length; r++) {
 if (feeEvents[r]!.tsMs >= cutoff) feeEvents[w++] = feeEvents[r]!;
 }
 feeEvents.length = w;
 pruneFeeEventsBefore(cutoff);
 if (before !== w) console.log(`[indexer] pruned ${before - w} stale fee events`);
}

async function backfill(
 client: PublicClient,
 vaultAddr: `0x${string}`,
 startBlock: bigint,
 head: bigint,
 chunk: bigint,
): Promise<void> {
 const total = head >= startBlock ? head - startBlock + 1n : 0n;
 let processed = 0n;
 for (let from = startBlock; from <= head; from += chunk) {
 const to = (from + chunk - 1n) > head ? head : (from + chunk - 1n);
 let logs: Log[];
 try {
 logs = await fetchAllEventLogs(client, vaultAddr, from, to);
 } catch (e) {
 console.warn(`[indexer] backfill chunk ${from}..${to} failed: ${e instanceof Error ? e.message : String(e)}`);
 processed += (to - from + 1n);
 continue;
 }
 // Cursor is persisted at `to` inside the same tx that folds the chunk —
 // a crash between chunks resumes cleanly from `to+1` next boot.
 await applyLogs(client, logs, to);
 processed += (to - from + 1n);
 const pct = total > 0n ? Number((processed * 100n) / total) : 100;
 console.log(`[indexer] backfill block ${to}/${head} (~${pct}%)`);
 }
}

async function fetchAllEventLogs(
 client: PublicClient,
 vaultAddr: `0x${string}`,
 fromBlock: bigint,
 toBlock: bigint,
): Promise<Log[]> {
 const logs = await client.getLogs({
 address: vaultAddr,
 events: [
 TRANSFER_EVENT, FEES_COLLECTED_EVENT, POOL_TRACKED_EVENT,
 DEPOSIT_EVENT, WITHDRAW_EVENT, LIQUIDITY_ADDED_EVENT,
 LIQUIDITY_REMOVED_EVENT, SWAPPED_EVENT,
 POSITION_TRACKED_EVENT, POSITION_UNTRACKED_EVENT,
 ],
 fromBlock,
 toBlock,
 });
 return logs as Log[];
}

// Apply a batch of mixed-event logs in (block, logIndex) order. Sorting
// strictly by (blockNumber, logIndex) keeps co-block events in canonical
// chain order — a same-tx deposit-then-partial-withdraw must FIFO against
// the lot that was just pushed.
//
// The fold runs inside a single sqlite transaction (one fsync per chunk
// regardless of how many events) which also persists the cursor at
// `cursorAt` if non-null. Watcher fan-out runs AFTER commit, so a callback
// throwing can't roll back ingested state.
async function applyLogs(client: PublicClient, logs: Log[], cursorAt: bigint | null): Promise<void> {
 const sorted = logs.slice().sort((a, b) => {
 const ba = a.blockNumber ?? 0n;
 const bb = b.blockNumber ?? 0n;
 if (ba !== bb) return ba < bb ? -1 : 1;
 const la = a.logIndex ?? 0;
 const lb = b.logIndex ?? 0;
 return la - lb;
 });

 // Pre-fetch unique block timestamps in parallel so each event below
 // resolves to a cache hit. Keeps backfill under the public RPC's burst
 // budget; on incremental ticks this is typically 1-2 blocks.
 const uniqueBlocks = Array.from(new Set(sorted.map((l) => l.blockNumber ?? 0n)));
 await prefetchBlockTimestamps(client, uniqueBlocks);

 const ZERO = "0x0000000000000000000000000000000000000000";

 // Synchronous fold inside one transaction. Returns the watcher targets.
 const { touchedWallets, actionDispatches } = withTransaction(() => {
 const tw = new Set<string>();
 const ad: AgentActionEvent[] = [];

 for (const log of sorted) {
 const evt = (log as Log & { eventName?: string }).eventName;
 const args = (log as Log & { args?: Record<string, unknown> }).args ?? {};
 const blockNumber = log.blockNumber ?? 0n;
 const logIndex = (log as Log & { logIndex?: number }).logIndex ?? 0;
 const txHash = ((log as Log & { transactionHash?: `0x${string}` }).transactionHash ?? "0x") as `0x${string}`;
 const blockTs = blockTsCache.get(blockNumber) ?? Math.floor(Date.now() / 1000);

 if (evt === "PoolTracked") {
 const poolKey = args.poolKey as `0x${string}`;
 const nonBaseToken = (args.nonBaseToken as `0x${string}`).toLowerCase() as `0x${string}`;
 const usdcIsToken0 = USDC_BASE_ADDRESS < nonBaseToken;
 poolOrientation.set(poolKey, { nonBaseToken, usdcIsToken0 });
 upsertPoolOrientation(poolKey, nonBaseToken, usdcIsToken0);
 } else if (evt === "Transfer") {
 const from = (args.from as `0x${string}`).toLowerCase();
 const to = (args.to as `0x${string}`).toLowerCase();
 const value = args.value as bigint;
 if (from !== ZERO) {
 const cur = balances.get(from) ?? 0n;
 const next = cur - value;
 if (next === 0n) {
 balances.delete(from);
 deleteBalance(from);
 } else {
 balances.set(from, next);
 upsertBalance(from, next);
 }
 }
 if (to !== ZERO) {
 const cur = balances.get(to) ?? 0n;
 const next = cur + value;
 balances.set(to, next);
 upsertBalance(to, next);
 }
 // Peer-to-peer share transfer: balances above are updated, but basis
 // is NOT migrated between wallets. See limitations in the header.
 if (from !== ZERO && to !== ZERO) {
 console.warn(`[indexer] peer share transfer ${from} -> ${to} value=${value} — basis NOT migrated`);
 }
 } else if (evt === "FeesCollected") {
 const poolKey = args.poolKey as `0x${string}`;
 const positionId = args.positionId as bigint;
 const amount0 = args.amount0 as bigint;
 const amount1 = args.amount1 as bigint;
 const meta = poolOrientation.get(poolKey);
 // Fee accounting requires orientation. Action dispatch fires either
 // way — orientation is recovered for chip rendering inside
 // buildActionMessage.
 if (meta) {
 const usdcAmount = meta.usdcIsToken0 ? amount0 : amount1;
 if (usdcAmount > 0n) {
 const id = `${txHash}:${logIndex}`;
 feeEvents.push({ id, tsMs: blockTs * 1000, usdcAmount, poolKey });
 insertFeeEvent(id, blockTs * 1000, usdcAmount, poolKey);
 }
 } else {
 // Backfill window started after the matching PoolTracked event.
 // Without orientation we can't tell which side is USDC, so this fee
 // event is dropped from basketEarned30d / basketApr / per-pool earned30d.
 console.warn(`[indexer] FeesCollected dropped — missing PoolTracked orientation for poolKey=${poolKey} (block ${blockNumber}, tx ${txHash})`);
 }
 ad.push({
 kind: "fees_collected", poolKey, positionId, amount0, amount1,
 tx: txHash, blockNumber, logIndex, blockTs,
 });
 } else if (evt === "LiquidityAdded") {
 const poolKey = args.poolKey as `0x${string}`;
 ad.push({
 kind: "liquidity_added",
 poolKey,
 positionId: args.positionId as bigint,
 amount0: args.amount0Used as bigint,
 amount1: args.amount1Used as bigint,
 tx: txHash, blockNumber, logIndex, blockTs,
 });
 } else if (evt === "LiquidityRemoved") {
 const poolKey = args.poolKey as `0x${string}`;
 ad.push({
 kind: "liquidity_removed",
 poolKey,
 positionId: args.positionId as bigint,
 amount0: args.amount0Out as bigint,
 amount1: args.amount1Out as bigint,
 tx: txHash, blockNumber, logIndex, blockTs,
 });
 } else if (evt === "Swapped") {
 ad.push({
 kind: "swapped",
 poolKey: args.poolKey as `0x${string}`,
 tokenIn: (args.tokenIn as `0x${string}`).toLowerCase() as `0x${string}`,
 amountIn: args.amountIn as bigint,
 amountOut: args.amountOut as bigint,
 tx: txHash, blockNumber, logIndex, blockTs,
 });
 } else if (evt === "PositionTracked") {
 ad.push({
 kind: "position_tracked",
 poolKey: args.poolKey as `0x${string}`,
 positionId: args.positionId as bigint,
 tx: txHash, blockNumber, logIndex, blockTs,
 });
 } else if (evt === "PositionUntracked") {
 ad.push({
 kind: "position_untracked",
 poolKey: args.poolKey as `0x${string}`,
 positionId: args.positionId as bigint,
 tx: txHash, blockNumber, logIndex, blockTs,
 });
 } else if (evt === "Deposit") {
 const owner = (args.owner as `0x${string}`).toLowerCase();
 const assets = args.assets as bigint;
 const shares = args.shares as bigint;
 if (shares === 0n) continue; // defensive; ERC4626 normally rejects this
 const tsMs = blockTs * 1000;
 const sharePriceAtEntry = (Number(assets) / 1e6) / (Number(shares) / Number(SHARE_UNIT));

 const idx = nextLotIndex.get(owner) ?? 0;
 const newLot: Lot = {
 lotIndex: idx,
 tsMs,
 assetsIn: assets,
 sharesMinted: shares,
 sharesRemaining: shares,
 sharePriceAtEntry,
 };
 const walletLots = lots.get(owner) ?? [];
 walletLots.push(newLot);
 lots.set(owner, walletLots);
 nextLotIndex.set(owner, idx + 1);
 appendLot(owner, idx, tsMs, assets, shares, shares, sharePriceAtEntry);

 if (!firstDepositTs.has(owner)) {
 firstDepositTs.set(owner, tsMs);
 upsertFirstDeposit(owner, tsMs);
 }

 const depositTx = (log as Log & { transactionHash?: `0x${string}` }).transactionHash ?? "0x";
 pushActivity(owner, {
 id: activityId(log),
 kind: "deposit",
 amount: Number(assets) / 1e6,
 token: "USDC",
 ts: new Date(tsMs).toISOString(),
 tx: depositTx,
 }, blockNumber);
 tw.add(owner);
 if (liveTailActive && /^0x[0-9a-fA-F]{64}$/.test(depositTx)) {
 notifyKeeperReact("deposit", assets, owner, depositTx);
 }
 } else if (evt === "Withdraw") {
 const owner = (args.owner as `0x${string}`).toLowerCase();
 const assets = args.assets as bigint;
 const shares = args.shares as bigint;
 const tsMs = blockTs * 1000;

 const walletLots = lots.get(owner) ?? [];
 let toConsume = shares;
 while (toConsume > 0n && walletLots.length > 0) {
 const head = walletLots[0]!;
 if (head.sharesRemaining <= toConsume) {
 toConsume -= head.sharesRemaining;
 deleteLot(owner, head.lotIndex);
 walletLots.shift();
 } else {
 head.sharesRemaining -= toConsume;
 updateLotRemaining(owner, head.lotIndex, head.sharesRemaining);
 toConsume = 0n;
 }
 }
 if (walletLots.length === 0) {
 lots.delete(owner);
 firstDepositTs.delete(owner);
 deleteFirstDeposit(owner);
 } else {
 lots.set(owner, walletLots);
 firstDepositTs.set(owner, walletLots[0]!.tsMs);
 upsertFirstDeposit(owner, walletLots[0]!.tsMs);
 }

 const withdrawTx = (log as Log & { transactionHash?: `0x${string}` }).transactionHash ?? "0x";
 pushActivity(owner, {
 id: activityId(log),
 kind: "withdraw",
 amount: Number(assets) / 1e6,
 token: "USDC",
 ts: new Date(tsMs).toISOString(),
 tx: withdrawTx,
 }, blockNumber);
 tw.add(owner);
 if (liveTailActive && /^0x[0-9a-fA-F]{64}$/.test(withdrawTx)) {
 notifyKeeperReact("withdraw", assets, owner, withdrawTx);
 }
 }
 }

 if (cursorAt !== null) upsertIndexerState("last_indexed_block", cursorAt.toString());
 return { touchedWallets: tw, actionDispatches: ad };
 });

 // Re-emit fan-out fires after the whole batch is folded so a same-block
 // deposit+withdraw produces a single re-emit per wallet.
 for (const w of touchedWallets) {
 const watchers = walletWatchers.get(w);
 if (!watchers) continue;
 for (const cb of watchers) {
 try { cb(); }
 catch (e) { console.warn(`[indexer] wallet watcher failed for ${w}: ${e instanceof Error ? e.message : String(e)}`); }
 }
 }

 // Agent-action fan-out is dispatched in (block, logIndex) order matching
 // `sorted`, so the agent ring's seq order tracks chain order even when a
 // single chunk contains co-block PoolTracked + LiquidityAdded.
 if (actionDispatches.length > 0 && agentActionWatchers.size > 0) {
 for (const evt of actionDispatches) {
 for (const cb of agentActionWatchers) {
 try { cb(evt); }
 catch (e) { console.warn(`[indexer] agent-action watcher failed: ${e instanceof Error ? e.message : String(e)}`); }
 }
 }
 }
}

// ----------------------------------------------------- helpers

function activityId(log: Log): string {
 const tx = (log as Log & { transactionHash?: string }).transactionHash ?? "0x";
 const li = (log as Log & { logIndex?: number }).logIndex ?? 0;
 return `${tx}:${li}`;
}

// Push to the wallet's activity buffer, newest-first, capped at ACTIVITY_CAP.
// Idempotent: if the most-recent row already has this id (e.g. backfill+
// incremental overlap), skip. Mirrors to sqlite + trims the persisted table
// to the same cap on every append.
function pushActivity(wallet: string, row: UserActivityRow, blockNumber: bigint): void {
 const list = activity.get(wallet) ?? [];
 if (list.length > 0 && list[0]!.id === row.id) return;
 list.unshift(row);
 if (list.length > ACTIVITY_CAP) list.length = ACTIVITY_CAP;
 activity.set(wallet, list);
 appendActivity(wallet, row, blockNumber);
 trimActivity(wallet);
}

// Pre-fetch missing block timestamps in parallel (concurrency
// BLOCK_TS_CONCURRENCY). Cache lives at module scope, so incremental ticks
// pay zero RPC after the initial backfill warms the cache.
async function prefetchBlockTimestamps(client: PublicClient, blocks: bigint[]): Promise<void> {
 const missing: bigint[] = [];
 for (const b of blocks) if (!blockTsCache.has(b)) missing.push(b);
 if (missing.length === 0) return;

 for (let i = 0; i < missing.length; i += BLOCK_TS_CONCURRENCY) {
 const slice = missing.slice(i, i + BLOCK_TS_CONCURRENCY);
 const results = await Promise.all(slice.map(async (b) => {
 try {
 const blk = await client.getBlock({ blockNumber: b });
 return { b, ts: Number(blk.timestamp) };
 } catch (e) {
 console.warn(`[indexer] getBlock(${b}) failed: ${e instanceof Error ? e.message : String(e)}`);
 // Fall back to "now" so the event still lands in today's bucket.
 return { b, ts: Math.floor(Date.now() / 1000) };
 }
 }));
 // Mirror cache writes to sqlite inside one transaction.
 withTransaction(() => {
 for (const { b, ts } of results) {
 blockTsCache.set(b, ts);
 upsertBlockTs(b, ts * 1000);
 }
 });
 }
}
