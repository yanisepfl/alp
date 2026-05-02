// Vault topic dispatcher. Owns:
// - the per-connection subscriber set (cid -> deliver callback)
// - either the random-walk mock ticker, or the chain reader
//
// Chain mode reads sharePrice + tvl from the deployed ALPVault every poll
// interval, samples a 30-point daily history at startup, and emits partial
// vault.tick frames when either headline value crosses an epsilon. The
// in-memory indexer (../indexer.ts) derives users / basketApr /
// basketEarned30d / apr30d from the vault's event logs and folds them
// into both the priming snapshot and the tick path; allocations and pools
// come from topics/vault-composition.ts via PoolRegistry + adapter reads.

import type { PublicClient } from "viem";
import type { StreamFrame, VaultSnapshot, VaultTick } from "../types";
import { currentVaultSnapshot, stepVault } from "../mocks/vault-state";
import { erc4626Abi, getPublicClient, SHARE_UNIT, vaultAddress } from "../chain";
import { getVaultStats, indexUpToHead } from "../indexer";
import { reEmitOnSharePriceTick } from "./user";
import { getCompositionSnapshot } from "./vault-composition";

type Deliver = (f: StreamFrame) => void;

const subs = new Map<string, Deliver>();

export function subscribeVault(cid: string, deliver: Deliver): void {
 subs.set(cid, deliver);
}

export function unsubscribeVault(cid: string): void {
 subs.delete(cid);
}

// Chain-derived state, scoped to the process lifetime. null = not yet read.
let chainAddress: `0x${string}` | null = null;
let chainSharePrice: number | null = null;
let chainTvl: number | null = null;
let chainSharePrice30d: number[] | null = null;
let chainTvl30d: number[] | null = null;
// Indexer-derived headlines, cached from each tick so the partial-tick
// emitter can diff them. The snapshot path always recomputes via
// getVaultStats against fresh chainTvl / chainTvl30d.
let chainUsers: number | null = null;
let chainBasketApr: number | null = null;
let chainBasketEarned30d: number | null = null;
let indexerEnabled = false;

const POLL_MS = 10000;
const EPS_SHARE_PRICE = 0.0001;
const EPS_TVL = 0.001;
const EPS_APR = 0.01;
const EPS_EARNED = 0.01;
// Base targets ~2s blocks → ~43,200 blocks per day.
const BLOCKS_PER_DAY = 43_200n;
const HISTORY_LEN = 30;

export function vaultSnapshotFrame(): StreamFrame {
 const snapshot = currentVaultSnapshot();
 if (chainAddress) snapshot.address = chainAddress;
 if (chainSharePrice !== null) snapshot.sharePrice = chainSharePrice;
 if (chainTvl !== null) snapshot.tvl = chainTvl;
 if (chainSharePrice30d !== null) snapshot.sharePrice30d = chainSharePrice30d;
 if (chainTvl30d !== null) snapshot.tvl30d = chainTvl30d;
 if (indexerEnabled) {
 const tvlMillions = chainTvl ?? 0;
 const tvl30dMillions = chainTvl30d ?? new Array(HISTORY_LEN).fill(tvlMillions);
 const stats = getVaultStats(tvlMillions, tvl30dMillions);
 snapshot.users = stats.users;
 snapshot.basketEarned30d = stats.earned30dUsd;
 snapshot.basketApr = stats.apr;
 snapshot.apr30d = stats.apr30d;
 chainUsers = stats.users;
 chainBasketApr = stats.apr;
 chainBasketEarned30d = stats.earned30dUsd;
 }
 // Replace mock allocations + pools with on-chain composition once the
 // read pipeline has primed. Returns null until first prime completes;
 // mock fallback covers the gap.
 if (chainReaderStarted) {
 const comp = getCompositionSnapshot();
 if (comp) {
 snapshot.allocations = comp.allocations;
 snapshot.pools = comp.pools;
 }
 }
 return { v: 1, type: "snapshot", topic: "vault", snapshot };
}

let mockTickerStarted = false;
export function startVaultMockTicker(): void {
 if (mockTickerStarted) return;
 mockTickerStarted = true;
 setInterval(() => {
 if (subs.size === 0) return;
 const tick = stepVault();
 const frame: StreamFrame = { v: 1, type: "tick", topic: "vault", tick };
 for (const deliver of subs.values()) deliver(frame);
 }, 5000);
}

let chainReaderStarted = false;
export async function startVaultChainReader(): Promise<void> {
 if (chainReaderStarted) return;
 const client = getPublicClient();
 const addr = vaultAddress();
 if (!client || !addr) {
 console.warn("[vault] startVaultChainReader: missing client or address — falling back to mock");
 startVaultMockTicker();
 return;
 }
 chainReaderStarted = true;
 chainAddress = addr;
 // index.ts toggles indexerEnabled via setIndexerEnabled() based on whether
 // startIndexer() succeeded — that's a bootstrap decision owned by the
 // entrypoint.

 await sample30d(client, addr);
 await pollOnce(client, addr); // primes chainSharePrice/chainTvl before first subscriber arrives
 setInterval(() => { void pollOnce(client, addr); }, POLL_MS);
}

// Allow index.ts to skip indexer-derived fields if startIndexer() failed
// or was not run. Safe default: off.
export function setIndexerEnabled(enabled: boolean): void {
 indexerEnabled = enabled;
}

// Read-only views consumed by other topics (notably topics/user.ts for the
// share-price-driven re-emit path and the chain-vs-mock branch).
export function currentSharePrice(): number {
 return chainSharePrice ?? currentVaultSnapshot().sharePrice;
}
export function isChainMode(): boolean { return chainReaderStarted; }
export function isIndexerEnabled(): boolean { return indexerEnabled; }

async function readVaultPair(
 client: PublicClient,
 addr: `0x${string}`,
 blockNumber?: bigint,
): Promise<{ sharePrice: number; tvl: number }> {
 const blockOpt = blockNumber !== undefined ? { blockNumber } : {};
 const [assetsForOneShare, totalAssets] = await Promise.all([
 client.readContract({
 address: addr,
 abi: erc4626Abi,
 functionName: "convertToAssets",
 // 1 share at the vault's actual decimals (USDC 6 + offset 6 = 12).
 args: [SHARE_UNIT],
 ...blockOpt,
 }),
 client.readContract({
 address: addr,
 abi: erc4626Abi,
 functionName: "totalAssets",
 ...blockOpt,
 }),
 ]);
 // sharePrice = USDC-out for 1 share / 1e6.
 // tvl is reported in millions of USD: totalAssets / 1e6 (USDC scale) / 1e6 (units → millions).
 return {
 sharePrice: Number(assetsForOneShare as bigint) / 1e6,
 tvl: Number(totalAssets as bigint) / 1e12,
 };
}

async function pollOnce(client: PublicClient, addr: `0x${string}`): Promise<void> {
 let result: { sharePrice: number; tvl: number };
 let head: bigint | null = null;
 try {
 [result, head] = await Promise.all([
 readVaultPair(client, addr),
 client.getBlockNumber(),
 ]);
 } catch (e) {
 console.warn(`[vault] poll failed: ${e instanceof Error ? e.message : String(e)}`);
 return;
 }
 const sp = round(result.sharePrice, 4);
 const tv = round(result.tvl, 3);

 // Hook the indexer onto the same tick. Errors are swallowed inside
 // indexUpToHead — chain headlines should never be blocked by indexer
 // misbehaviour.
 if (indexerEnabled && head !== null) {
 await indexUpToHead(client, addr, head);
 }

 const tick: VaultTick = { ts: new Date().toISOString() };
 let changed = false;
 if (chainSharePrice === null || Math.abs(sp - chainSharePrice) >= EPS_SHARE_PRICE) {
 tick.sharePrice = sp;
 chainSharePrice = sp;
 changed = true;
 }
 if (chainTvl === null || Math.abs(tv - chainTvl) >= EPS_TVL) {
 tick.tvl = tv;
 chainTvl = tv;
 changed = true;
 }

 // Recompute indexer-derived headlines against the (possibly updated) tvl
 // series and emit only the ones that crossed their epsilon. apr30d is
 // intentionally not ticked outside of EOD rollover.
 if (indexerEnabled && chainTvl !== null) {
 const stats = getVaultStats(chainTvl, chainTvl30d ?? new Array(HISTORY_LEN).fill(chainTvl));
 if (chainUsers === null || stats.users !== chainUsers) {
 tick.users = stats.users;
 chainUsers = stats.users;
 changed = true;
 }
 if (chainBasketApr === null || Math.abs(stats.apr - chainBasketApr) >= EPS_APR) {
 tick.basketApr = stats.apr;
 chainBasketApr = stats.apr;
 changed = true;
 }
 if (chainBasketEarned30d === null || Math.abs(stats.earned30dUsd - chainBasketEarned30d) >= EPS_EARNED) {
 tick.basketEarned30d = stats.earned30dUsd;
 chainBasketEarned30d = stats.earned30dUsd;
 changed = true;
 }
 // apr30d is intentionally not stamped onto the partial tick; clients
 // receive it on the next snapshot (e.g. on (re)subscribe).
 }

 // Share-price-driven user re-emit. Runs every poll regardless of whether
 // the vault tick "changed" — user-facing valueUsd recomputes off live
 // shares x live sharePrice, debounced per-connection inside
 // reEmitOnSharePriceTick.
 reEmitOnSharePriceTick();

 if (!changed || subs.size === 0) return;

 const frame: StreamFrame = { v: 1, type: "tick", topic: "vault", tick };
 for (const deliver of subs.values()) deliver(frame);
}

async function sample30d(client: PublicClient, addr: `0x${string}`): Promise<void> {
 let head: bigint;
 try {
 head = await client.getBlockNumber();
 } catch (e) {
 console.warn(`[vault] 30d sample: getBlockNumber failed (${e instanceof Error ? e.message : String(e)}) — keeping mock series`);
 return;
 }
 console.log(`[vault] 30d sample: head=${head}, batching ${HISTORY_LEN} points`);

 const targets: bigint[] = [];
 for (let i = HISTORY_LEN - 1; i >= 0; i--) {
 const t = head - BigInt(i) * BLOCKS_PER_DAY;
 targets.push(t > 0n ? t : 1n);
 }

 const sharePrices: (number | null)[] = new Array(HISTORY_LEN).fill(null);
 const tvls: (number | null)[] = new Array(HISTORY_LEN).fill(null);

 // Public Base RPC throttles aggressively; batch in groups of 5.
 const BATCH = 5;
 for (let off = 0; off < HISTORY_LEN; off += BATCH) {
 const slice = targets.slice(off, off + BATCH);
 const results = await Promise.all(slice.map(async (b) => {
 try {
 return await readVaultPair(client, addr, b);
 } catch (e) {
 console.warn(`[vault] 30d sample: block ${b} failed: ${e instanceof Error ? e.message : String(e)}`);
 return null;
 }
 }));
 for (let k = 0; k < results.length; k++) {
 const r = results[k];
 if (r) {
 sharePrices[off + k] = round(r.sharePrice, 4);
 tvls[off + k] = round(r.tvl, 3);
 }
 }
 console.log(`[vault] 30d sample: ${Math.min(off + BATCH, HISTORY_LEN)}/${HISTORY_LEN}`);
 }

 // Forward-fill failed slots from the last successful value, then back-fill
 // any leading gap from the first successful value, so the array stays
 // length 30 with no nulls.
 let lastSp: number | null = null;
 let lastTv: number | null = null;
 for (let i = 0; i < HISTORY_LEN; i++) {
 const sp = sharePrices[i];
 if (sp != null) lastSp = sp;
 else if (lastSp !== null) sharePrices[i] = lastSp;
 const tv = tvls[i];
 if (tv != null) lastTv = tv;
 else if (lastTv !== null) tvls[i] = lastTv;
 }
 for (let i = HISTORY_LEN - 1; i >= 0; i--) {
 if (sharePrices[i] == null) {
 const next = sharePrices[i + 1];
 if (next != null) sharePrices[i] = next;
 }
 if (tvls[i] == null) {
 const nextT = tvls[i + 1];
 if (nextT != null) tvls[i] = nextT;
 }
 }

 if (sharePrices.some(v => v === null) || tvls.some(v => v === null)) {
 console.warn("[vault] 30d sample: all samples failed — falling back to mock series");
 const mock = currentVaultSnapshot();
 chainSharePrice30d = mock.sharePrice30d;
 chainTvl30d = mock.tvl30d;
 return;
 }
 chainSharePrice30d = sharePrices as number[];
 chainTvl30d = tvls as number[];
 console.log(`[vault] 30d sample: complete (sharePrice last=${chainSharePrice30d[HISTORY_LEN - 1]}, tvl last=${chainTvl30d[HISTORY_LEN - 1]})`);
}

function round(n: number, d: number): number { return Number(n.toFixed(d)); }

// Re-export so ws.ts can build initial-snapshot priming without touching mocks.
export type { VaultSnapshot };
