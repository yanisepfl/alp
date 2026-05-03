// Derives snapshot.allocations + snapshot.pools from on-chain reads against
// the deployed ALPVault. Owns:
// - the chain-read pipeline (getActivePools → trackedPool / getPositionIds
//   / poolValueExternal / adapter.getSpotSqrtPriceX96 /
//   adapter.getPositionAmountsAtPrice + USDC.balanceOf for idle reserve)
// - a 10s module-scope cache (subscribers + vault tick + user tick all hit
//   this every snapshot path)
// - invalidation on indexer agent-action events (LiquidityAdded /
//   LiquidityRemoved / Swapped / FeesCollected) so the next composition
//   read is fresh after the agent moves the basket
//
// Boot policy: the first snapshot may serve the mock fallback for ~5-10s
// while the priming read completes; subsequent snapshots use the cache.
// On read error, fall back to last-known cached value, then to null (caller
// substitutes mock). Never crash the snapshot path.

import type { PublicClient } from "viem";
import {
 adapterAbi, erc20BalanceAbi, tokenSymbolForAddress, USDC_BASE_ADDRESS,
 vaultCompositionAbi,
} from "../chain";
import { getPoolEarned30dUsd, subscribeAgentActions } from "../indexer";
import type { TokenSymbol, VaultAllocation, VaultPool } from "../types";

const CACHE_TTL_MS = 10_000;
const Q96 = 1n << 96n;

type Pool = {
 adapter: `0x${string}`;
 token0: `0x${string}`;
 token1: `0x${string}`;
 hooks: `0x${string}`;
 fee: number;
 tickSpacing: number;
 maxAllocationBps: number;
 enabled: boolean;
};

export type CompositionSnapshot = {
 allocations: VaultAllocation[];
 pools: VaultPool[];
};

let client: PublicClient | null = null;
let vaultAddr: `0x${string}` | null = null;

let cache: CompositionSnapshot | null = null;
let cacheAt = 0;
let inflight: Promise<CompositionSnapshot | null> | null = null;
let started = false;

export function startComposition(c: PublicClient, addr: `0x${string}`): void {
 if (started) return;
 started = true;
 client = c;
 vaultAddr = addr;

 // Prime the cache off the boot path so the first snapshot can serve real
 // data when the FE arrives. Don't await — boot must not block on RPCs.
 void refresh().catch((e) => {
 console.warn(`[vault-composition] initial prime failed: ${e instanceof Error ? e.message : String(e)}`);
 });

 // Every agent action that mutates basket composition drops the cache so
 // the next snapshot rebuilds against fresh state.
 subscribeAgentActions((evt) => {
 if (
 evt.kind === "liquidity_added" ||
 evt.kind === "liquidity_removed" ||
 evt.kind === "swapped" ||
 evt.kind === "fees_collected"
 ) {
 invalidate(evt.kind);
 }
 });
}

export function getCompositionSnapshot(): CompositionSnapshot | null {
 if (!started || !client || !vaultAddr) return null;
 // Refresh in the background if stale; return whatever we already have so
 // the caller never blocks. First call after invalidate returns the prior
 // cache; the next call gets the fresh value.
 if (Date.now() - cacheAt > CACHE_TTL_MS && !inflight) {
 inflight = refresh()
 .catch((e) => {
 console.warn(`[vault-composition] background refresh failed: ${e instanceof Error ? e.message : String(e)}`);
 return cache;
 })
 .finally(() => { inflight = null; });
 }
 return cache;
}

function invalidate(reason: string): void {
 cacheAt = 0;
 console.log(`[vault-composition] invalidated by ${reason}`);
}

async function refresh(): Promise<CompositionSnapshot | null> {
 if (!client || !vaultAddr) return cache;
 const c = client;
 const addr = vaultAddr;

 let activeKeys: readonly `0x${string}`[];
 try {
 activeKeys = (await c.readContract({
 address: addr,
 abi: vaultCompositionAbi,
 functionName: "getActivePools",
 })) as readonly `0x${string}`[];
 } catch (e) {
 console.warn(`[vault-composition] getActivePools failed: ${e instanceof Error ? e.message : String(e)}`);
 return cache;
 }

 // Read pool meta + per-pool USD value + position id list in parallel.
 // poolValueExternal is the same view totalAssets() rolls up internally,
 // so pool.pct against totalAssets stays consistent with the headline TVL.
 let poolMetas: Pool[];
 let poolValues: bigint[];
 let positionIds: ReadonlyArray<readonly bigint[]>;
 try {
 [poolMetas, poolValues, positionIds] = await Promise.all([
 Promise.all(activeKeys.map((k) => c.readContract({
 address: addr, abi: vaultCompositionAbi, functionName: "trackedPool", args: [k],
 }) as Promise<Pool>)),
 Promise.all(activeKeys.map((k) => c.readContract({
 address: addr, abi: vaultCompositionAbi, functionName: "poolValueExternal", args: [k],
 }) as Promise<bigint>)),
 Promise.all(activeKeys.map((k) => c.readContract({
 address: addr, abi: vaultCompositionAbi, functionName: "getPositionIds", args: [k],
 }) as Promise<readonly bigint[]>)),
 ]);
 } catch (e) {
 console.warn(`[vault-composition] pool meta read failed: ${e instanceof Error ? e.message : String(e)}`);
 return cache;
 }

 // Per-pool spot price (sqrtPriceX96), used for both per-position
 // decomposition AND token-level USD pricing of the non-USDC side.
 let spotPrices: bigint[];
 try {
 spotPrices = await Promise.all(poolMetas.map((pm) => c.readContract({
 address: pm.adapter, abi: adapterAbi, functionName: "getSpotSqrtPriceX96", args: [pm],
 }) as Promise<bigint>));
 } catch (e) {
 console.warn(`[vault-composition] spot price read failed: ${e instanceof Error ? e.message : String(e)}`);
 return cache;
 }

 // Per-position decomposition. One promise per (pool, positionId);
 // adapter.getPositionAmountsAtPrice mirrors the contract's
 // _poolValueWithIdle path, so the sum is identical (modulo idle non-base
 // attribution, aggregated explicitly via USDC.balanceOf below).
 type PosFetch = { poolIdx: number; positionId: bigint };
 const posFetches: PosFetch[] = [];
 positionIds.forEach((ids, poolIdx) => {
 for (const id of ids) posFetches.push({ poolIdx, positionId: id });
 });
 let positionAmounts: Array<{ amount0: bigint; amount1: bigint }>;
 try {
 positionAmounts = await Promise.all(posFetches.map((p) => c.readContract({
 address: poolMetas[p.poolIdx]!.adapter,
 abi: adapterAbi,
 functionName: "getPositionAmountsAtPrice",
 args: [poolMetas[p.poolIdx]!, p.positionId, spotPrices[p.poolIdx]!],
 }) as Promise<readonly [bigint, bigint]>)).then((arr) =>
 arr.map(([amount0, amount1]) => ({ amount0, amount1 })),
 );
 } catch (e) {
 console.warn(`[vault-composition] position amounts read failed: ${e instanceof Error ? e.message : String(e)}`);
 return cache;
 }

 // Idle balances. USDC.balanceOf(vault) is idle base; non-base tokens
 // (cbBTC, ETH/WETH, USDT) sometimes sit unallocated between rebalances
 // and ALPVault's poolValueExternal attributes them to the pool registered
 // as their valuation source. They must enter our token aggregation too —
 // otherwise (sum of pools' pct) overshoots 100% (pools include non-base
 // idle but our token totals don't).
 const uniqueNonBaseTokens = Array.from(new Set(
 poolMetas.flatMap((pm) => {
 const t0 = pm.token0.toLowerCase();
 const t1 = pm.token1.toLowerCase();
 const out: `0x${string}`[] = [];
 if (t0 !== USDC_BASE_ADDRESS) out.push(pm.token0);
 if (t1 !== USDC_BASE_ADDRESS) out.push(pm.token1);
 return out;
 }).map((a) => a.toLowerCase() as `0x${string}`),
 ));
 let idleUsdcBase: bigint;
 let idleNonBaseRaw = new Map<TokenSymbol, bigint>();
 try {
 const balances = await Promise.all([
 c.readContract({
 address: USDC_BASE_ADDRESS as `0x${string}`,
 abi: erc20BalanceAbi,
 functionName: "balanceOf",
 args: [addr],
 }) as Promise<bigint>,
 ...uniqueNonBaseTokens.map((t) =>
 // Native ETH isn't an ERC20 — balanceOf on 0x0 reverts. The V4
 // ETH/USDC pool stores idle ETH as the vault's native balance,
 // read separately below.
 t === "0x0000000000000000000000000000000000000000"
 ? Promise.resolve(0n)
 : c.readContract({
 address: t, abi: erc20BalanceAbi,
 functionName: "balanceOf", args: [addr],
 }) as Promise<bigint>,
 ),
 ]);
 idleUsdcBase = balances[0]!;
 for (let i = 0; i < uniqueNonBaseTokens.length; i++) {
 const t = uniqueNonBaseTokens[i]!;
 const sym = tokenSymbolForAddress(t);
 const bal = balances[i + 1]!;
 if (bal > 0n) idleNonBaseRaw.set(sym, (idleNonBaseRaw.get(sym) ?? 0n) + bal);
 }
 // Native ETH idle: vault's own ETH balance, only relevant if a V4 pool
 // uses native ETH as a token.
 if (uniqueNonBaseTokens.includes("0x0000000000000000000000000000000000000000")) {
 try {
 const nativeBal = await c.getBalance({ address: addr });
 if (nativeBal > 0n) idleNonBaseRaw.set("ETH", (idleNonBaseRaw.get("ETH") ?? 0n) + nativeBal);
 } catch (e) {
 console.warn(`[vault-composition] native ETH balance read failed: ${e instanceof Error ? e.message : String(e)}`);
 }
 }
 } catch (e) {
 console.warn(`[vault-composition] idle balance reads failed: ${e instanceof Error ? e.message : String(e)}`);
 idleUsdcBase = 0n;
 idleNonBaseRaw = new Map();
 }

 // ---- Aggregate ----

 // Token totals in raw base units (USDC 6, USDT 6, ETH 18, BTC 8). Sums
 // position amounts across every pool plus all idle balances. Must mirror
 // what poolValueExternal accounts for, otherwise per-pool pct sums
 // diverge from 100%.
 const tokenRaw = new Map<TokenSymbol, bigint>();
 const addRaw = (sym: TokenSymbol, n: bigint) => {
 if (n === 0n) return;
 tokenRaw.set(sym, (tokenRaw.get(sym) ?? 0n) + n);
 };

 for (let i = 0; i < posFetches.length; i++) {
 const p = posFetches[i]!;
 const amt = positionAmounts[i]!;
 const pm = poolMetas[p.poolIdx]!;
 addRaw(tokenSymbolForAddress(pm.token0), amt.amount0);
 addRaw(tokenSymbolForAddress(pm.token1), amt.amount1);
 }
 addRaw("USDC", idleUsdcBase);
 for (const [sym, raw] of idleNonBaseRaw) addRaw(sym, raw);

 // For non-USDC tokens, build a "to-USDC" sqrtPrice map by walking the
 // active pools — the first USDC-paired pool that surfaces a token is its
 // pricing source. Stables (USDT) are treated as $1. Tokens with no
 // USDC-paired pool fall through with $0 USD value (allocation pct
 // under-counts, but gauges still move with chain state).
 type Px = { sqrtPriceX96: bigint; usdcIsToken0: boolean };
 const nonUsdcPx = new Map<TokenSymbol, Px>();
 for (let i = 0; i < poolMetas.length; i++) {
 const pm = poolMetas[i]!;
 const sp = spotPrices[i]!;
 const t0 = pm.token0.toLowerCase();
 const t1 = pm.token1.toLowerCase();
 const usdcIsToken0 = t0 === USDC_BASE_ADDRESS;
 const usdcIsToken1 = t1 === USDC_BASE_ADDRESS;
 if (!usdcIsToken0 && !usdcIsToken1) continue;
 const nonBaseAddr = usdcIsToken0 ? pm.token1 : pm.token0;
 const sym = tokenSymbolForAddress(nonBaseAddr);
 if (sym === "USDC") continue;
 if (!nonUsdcPx.has(sym)) {
 nonUsdcPx.set(sym, { sqrtPriceX96: sp, usdcIsToken0 });
 }
 }

 // Convert raw token totals to USDC-base-unit equivalents for the
 // allocations rollup.
 const tokenUsdcBase = new Map<TokenSymbol, bigint>();
 for (const [sym, raw] of tokenRaw) {
 if (raw === 0n) continue;
 let usdcBase: bigint;
 if (sym === "USDC") {
 usdcBase = raw;
 } else if (sym === "USDT") {
 // USDT 6 dec, USDC 6 dec — $1 stable equivalence, raw units align.
 usdcBase = raw;
 } else {
 const px = nonUsdcPx.get(sym);
 if (!px) {
 // No pricing source — fall through with 0 contribution.
 continue;
 }
 usdcBase = convertNonBaseToUsdcBase(raw, px.sqrtPriceX96, px.usdcIsToken0);
 }
 tokenUsdcBase.set(sym, usdcBase);
 }

 // Single denominator for both allocations and per-pool pct so the two
 // gauges stay mutually consistent. Mirrors ALPVault._marketTAV: idle USDC
 // + sum(poolValueExternal). Falls back to the token-derived total if
 // poolValues sum to 0 (all pools empty pre-deposit).
 const sumPoolValues = poolValues.reduce((s, v) => s + v, 0n);
 const marketTotalBase = idleUsdcBase + sumPoolValues;
 const totalUsdcBase = marketTotalBase > 0n
 ? marketTotalBase
 : Array.from(tokenUsdcBase.values()).reduce((s, v) => s + v, 0n);

 // Sort allocations by descending pct so the FE chip row reads naturally.
 const allocations: VaultAllocation[] = [];
 if (totalUsdcBase > 0n) {
 const entries: Array<{ token: TokenSymbol; pct: number }> = [];
 for (const [sym, usdcBase] of tokenUsdcBase) {
 const pct = Number((usdcBase * 10000n) / totalUsdcBase) / 100;
 if (pct > 0) entries.push({ token: sym, pct: round(pct, 2) });
 }
 entries.sort((a, b) => b.pct - a.pct);
 allocations.push(...entries);
 }

 // ---- Per-pool VaultPool entries ----

 const pools: VaultPool[] = [];
 for (let i = 0; i < poolMetas.length; i++) {
 const pm = poolMetas[i]!;
 const valueBase = poolValues[i]!;
 const pct = totalUsdcBase > 0n
 ? Number((valueBase * 10000n) / totalUsdcBase) / 100
 : 0;
 const sym0 = tokenSymbolForAddress(pm.token0);
 const sym1 = tokenSymbolForAddress(pm.token1);
 // Render convention: non-USDC token first when paired with USDC. The FE
 // colors the chip off `position.left`.
 const left = sym0 === "USDC" ? sym1 : sym0;
 const right = sym0 === "USDC" ? "USDC" : (sym1 === "USDC" ? "USDC" : sym1);
 const label = `${left}/${right}`;
 const slug = poolSlugFor(activeKeys[i]!, pm, sym0, sym1);
 const earned30dUsd = round(getPoolEarned30dUsd(activeKeys[i]!), 2);
 const apr = aprFor(earned30dUsd, valueBase);
 pools.push({
 slug, label,
 pct: round(pct, 2),
 position: { kind: "pair", left, right },
 apr: round(apr, 2),
 earned30d: earned30dUsd,
 });
 }

 // Idle reserve as a single-token entry. Always surfaced (even at 0%) so
 // the FE pool list shape is stable across rebalances. Idle USDC doesn't
 // accrue fees, so apr/earned30d are zero.
 const idlePct = totalUsdcBase > 0n
 ? Number((idleUsdcBase * 10000n) / totalUsdcBase) / 100
 : 0;
 pools.push({
 slug: "idle-reserve",
 label: "Idle reserve",
 pct: round(idlePct, 2),
 position: { kind: "single", token: "USDC" },
 apr: 0,
 earned30d: 0,
 });

 const next: CompositionSnapshot = { allocations, pools };
 cache = next;
 cacheAt = Date.now();
 console.log(`[vault-composition] cache populated: ${pools.length} pools, ${allocations.length} tokens`);
 return next;
}

// Mirrors ALPVault._convertToBase:
//   nonBaseIsToken0 → base = amount * (sqrtPriceX96 / 2^96)^2
//   else            → base = amount / (sqrtPriceX96 / 2^96)^2
// bigint math keeps precision over the wide dynamic range of (BTC 8 dec)
// x (sqrtPriceX96 ~Q64.96).
function convertNonBaseToUsdcBase(amount: bigint, sqrtPriceX96: bigint, usdcIsToken0: boolean): bigint {
 if (amount === 0n || sqrtPriceX96 === 0n) return 0n;
 // usdcIsToken0 maps to nonBaseIsToken0=false → divide.
 const nonBaseIsToken0 = !usdcIsToken0;
 if (nonBaseIsToken0) {
 return (amount * sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
 }
 return (amount * Q96 * Q96) / (sqrtPriceX96 * sqrtPriceX96);
}

// Stable, descriptive slug combining the token pair with the fee tier so
// FE caches keyed on slug stay distinct across pools that share a pair
// (e.g. USDC/USDT 0.01% vs 0.05%). Same poolKey always produces the same
// slug.
function poolSlugFor(poolKey: `0x${string}`, pm: Pool, sym0: TokenSymbol, sym1: TokenSymbol): string {
 const lower = (s: TokenSymbol) => s.toLowerCase();
 const pairLeft = sym0 === "USDC" ? lower(sym1) : lower(sym0);
 const pairRight = sym0 === "USDC" ? "usdc" : (sym1 === "USDC" ? "usdc" : lower(sym1));
 // V4 pools have a non-zero hooks address; tag them for clarity.
 const v4 = pm.hooks !== "0x0000000000000000000000000000000000000000" ? "-v4" : "";
 // Fee tier in pip-friendly form: 100 -> 001, 500 -> 005, 3000 -> 030.
 // V4 dynamic-fee pools set the high bit (0x800000); render as "dyn".
 const DYN_FEE = 0x800000;
 const feeStr = (pm.fee & DYN_FEE)
 ? "dyn"
 : Math.floor(pm.fee / 100).toString().padStart(3, "0");
 void poolKey;
 return `${pairLeft}-${pairRight}-${feeStr}${v4}`;
}

function aprFor(usdEarned: number, tvlBase: bigint): number {
 if (tvlBase < 1_000_000n) return 0; // < $1 in pool — APR meaningless
 const tvlUsd = Number(tvlBase) / 1e6;
 // 30d → annualised
 return (usdEarned / tvlUsd) * (365 / 30) * 100;
}

function round(n: number, d: number): number { return Number(n.toFixed(d)); }
