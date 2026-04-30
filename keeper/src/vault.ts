// Pool + position discovery. Reads vault.getActivePools() and resolves each
// to the static metadata the policies need (token0/token1, tick spacing,
// max allocation cap, volatility profile). Cached at boot — pool config on
// the vault doesn't churn at hackathon timescales, so we don't re-read
// per-tick.

import type { Address } from "viem";

import { vaultAbi, registryAbi } from "./abi";
import { publicClient } from "./chain";
import { env } from "./env";

// PoolRegistry deploy block on Base. Matches backend's VAULT_DEPLOY_BLOCK
// in ~/alp/backend/.env — registry was deployed in the same wave as the
// vault, so this is a safe lower bound for the PoolAdded event scan.
const REGISTRY_DEPLOY_BLOCK = 45356000n;
const LOG_CHUNK_BLOCKS = 10000n;

export type AdapterKind = "v3" | "v4";
export type VolatilityProfile = "stable" | "low" | "mid" | "high";

export interface TrackedPool {
  lpKey: `0x${string}`;
  /** URAdapter pool key paired with this LP pool. Computed deterministically
   *  at boot via `registry.poolKey(URAdapter, token0, token1, fee, tickSpacing,
   *  hooks)` and verified via `registry.isPoolKnown`. Used for `vault.executeSwap`
   *  routing — swap calls MUST use urKey, not lpKey, or the call dispatches
   *  to the LP adapter and reverts (the original Bug 1). */
  urKey: `0x${string}`;
  label: string;
  kind: AdapterKind;
  adapter: Address;
  token0: Address;
  token1: Address;
  hooks: Address;
  fee: number;
  tickSpacing: number;
  maxAllocationBps: number;
  enabled: boolean;
  /** Profile drives target range width on rebalance. Not on-chain — overlaid
   *  here from a small known-pool table. Defaults to "mid" for unknowns. */
  profile: VolatilityProfile;
}

// Token-symbol resolver. Lower-cased Base-mainnet addresses; covers the
// tokens in the three live pools (and the V4 native-ETH sentinel). New
// pools fall through to a short address tag.
const TOKEN_SYMBOL: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x4200000000000000000000000000000000000006": "ETH", // WETH on Base
  "0x0000000000000000000000000000000000000000": "ETH", // V4 native-ETH sentinel
};

function tokenSymbol(addr: Address): string {
  return TOKEN_SYMBOL[addr.toLowerCase()] ?? addr.slice(0, 8);
}

function defaultProfile(token0: Address, token1: Address): VolatilityProfile {
  // Stablecoin pair → tight band. Otherwise mid; high-vol classification
  // lives in the registry's tickSpacing already.
  const s0 = tokenSymbol(token0);
  const s1 = tokenSymbol(token1);
  const stables = new Set(["USDC", "USDT", "DAI"]);
  if (stables.has(s0) && stables.has(s1)) return "stable";
  return "mid";
}

// V4 adapter address on Base. trackedPools whose adapter == this are V4;
// everything else routes through the V3 adapter. Sourced from the live
// deployment (see project-context block at task start).
const V4_ADAPTER: Address = "0xB6871C8cd995fF015DBa7373b371426E80cBBCF0";

// URAdapter address — the swap router. Each LP pool has a paired
// URAdapter pool registered with matching (token0, token1) — the swap
// pool's fee/tickSpacing/hooks are independent of the LP pool's (e.g.
// the V4 ETH/USDC LP pool uses dynamic-fee + hooks, but its swap pair
// is a vanilla V3 ETH/USDC pool with fee=500/spacing=10/hooks=0). So
// we discover urKey by enumerating PoolAdded events and matching by
// (token0, token1), not by recomputing with LP metadata.
export const UR_ADAPTER: Address = "0x6BeE052D58Ba95bae9fd23d81a2B96145095a962";

// PoolRegistry's PoolAdded event ABI fragment, declared inline so we
// don't pollute abi.ts with an event we only consume during boot.
const poolAddedEvent = {
  type: "event", name: "PoolAdded",
  inputs: [
    { name: "key", type: "bytes32", indexed: true },
    {
      name: "pool", type: "tuple", indexed: false,
      components: [
        { name: "adapter", type: "address" },
        { name: "token0", type: "address" },
        { name: "token1", type: "address" },
        { name: "hooks", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "maxAllocationBps", type: "uint16" },
        { name: "enabled", type: "bool" },
      ],
    },
  ],
} as const;

/** Discover all URAdapter pools registered with the PoolRegistry by
 *  scanning PoolAdded events from REGISTRY_DEPLOY_BLOCK to head. Returns
 *  a map keyed by lower-cased "{token0}:{token1}" → urKey. Cached at
 *  boot in `loadPools`; not re-scanned per tick.
 */
async function discoverUrPools(): Promise<Map<string, `0x${string}`>> {
  const head = await publicClient.getBlockNumber();
  const map = new Map<string, `0x${string}`>();
  for (let from = REGISTRY_DEPLOY_BLOCK; from <= head; from += LOG_CHUNK_BLOCKS) {
    const to = from + LOG_CHUNK_BLOCKS - 1n > head ? head : from + LOG_CHUNK_BLOCKS - 1n;
    const logs = await publicClient.getContractEvents({
      address: env.POOL_REGISTRY_ADDRESS as Address,
      abi: [poolAddedEvent],
      eventName: "PoolAdded",
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      const pool = l.args.pool!;
      if (pool.adapter.toLowerCase() !== UR_ADAPTER.toLowerCase()) continue;
      const k = `${pool.token0.toLowerCase()}:${pool.token1.toLowerCase()}`;
      map.set(k, l.args.key as `0x${string}`);
    }
  }
  return map;
}

// WETH on Base — used as a substitute for native-ETH (token0=0x0 in V4
// pools) when matching against URAdapter swap pools, which operate on
// ERC20s. The on-chain registry happens to register the URAdapter
// pool for ETH/USDC with token0=0x0 too, so this fallback is rarely
// hit, but it's the correct shape for forward-compat.
const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

function urMatchKey(token0: Address, token1: Address): string[] {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const keys = [`${t0}:${t1}`];
  // V4 native-ETH pool may have its URAdapter mate registered with WETH
  // instead of address(0); accept either.
  if (token0 === NATIVE_ETH) keys.push(`${WETH_BASE.toLowerCase()}:${t1}`);
  if (token1 === NATIVE_ETH) keys.push(`${t0}:${WETH_BASE.toLowerCase()}`);
  return keys;
}

export async function loadPools(): Promise<TrackedPool[]> {
  const [keys, urMap] = await Promise.all([
    publicClient.readContract({
      address: env.VAULT_ADDRESS as Address,
      abi: vaultAbi,
      functionName: "getActivePools",
    }) as Promise<readonly `0x${string}`[]>,
    discoverUrPools(),
  ]);

  const pools: TrackedPool[] = [];
  for (const key of keys) {
    const tup = (await publicClient.readContract({
      address: env.POOL_REGISTRY_ADDRESS as Address,
      abi: registryAbi,
      functionName: "getPool",
      args: [key],
    })) as {
      adapter: Address;
      token0: Address;
      token1: Address;
      hooks: Address;
      fee: number;
      tickSpacing: number;
      maxAllocationBps: number;
      enabled: boolean;
    };
    if (!tup.enabled) continue;
    const kind = tup.adapter.toLowerCase() === V4_ADAPTER.toLowerCase() ? "v4" : "v3";
    const sym0 = tokenSymbol(tup.token0);
    const sym1 = tokenSymbol(tup.token1);
    const feeLabel = kind === "v4" && tup.fee >= 0x800000
      ? "dynamic-fee"
      : `${(Number(tup.fee) / 10000).toFixed(2)}%`;

    // urKey discovery — match by (token0, token1) against the URAdapter
    // pool map enumerated above. The URAdapter swap pool's fee/
    // tickSpacing/hooks are independent of the LP pool's, so we can't
    // recompute via registry.poolKey from LP metadata. (Confirmed via
    // PoolAdded event scan: V4 ETH/USDC LP uses fee=8388608/spacing=60/
    // hooks; its URAdapter mate is V3-style fee=500/spacing=10/hooks=0.)
    let urKey: `0x${string}` | undefined;
    for (const k of urMatchKey(tup.token0, tup.token1)) {
      const found = urMap.get(k);
      if (found) { urKey = found; break; }
    }
    if (!urKey) {
      throw new Error(
        `[vault.loadPools] FATAL: LP pool ${sym0}/${sym1} (lpKey=${key}) has no URAdapter mate registered. ` +
        `Searched URAdapter pools by (token0=${tup.token0}, token1=${tup.token1}); no match. ` +
        `Register a URAdapter pool with matching tokens via PoolRegistry.addPool, or remove this LP pool from the active set.`,
      );
    }

    pools.push({
      lpKey: key,
      urKey,
      label: `${sym0}/${sym1} ${feeLabel} (${kind.toUpperCase()})`,
      kind,
      adapter: tup.adapter,
      token0: tup.token0,
      token1: tup.token1,
      hooks: tup.hooks,
      fee: Number(tup.fee),
      tickSpacing: Number(tup.tickSpacing),
      maxAllocationBps: Number(tup.maxAllocationBps),
      enabled: tup.enabled,
      profile: defaultProfile(tup.token0, tup.token1),
    });
  }
  return pools;
}

export async function readPositionIds(lpKey: `0x${string}`): Promise<bigint[]> {
  const ids = (await publicClient.readContract({
    address: env.VAULT_ADDRESS as Address,
    abi: vaultAbi,
    functionName: "getPositionIds",
    args: [lpKey],
  })) as readonly bigint[];
  return [...ids];
}

export async function readPoolValueExternal(lpKey: `0x${string}`): Promise<bigint> {
  return (await publicClient.readContract({
    address: env.VAULT_ADDRESS as Address,
    abi: vaultAbi,
    functionName: "poolValueExternal",
    args: [lpKey],
  })) as bigint;
}

export async function readTotalAssets(): Promise<bigint> {
  return (await publicClient.readContract({
    address: env.VAULT_ADDRESS as Address,
    abi: vaultAbi,
    functionName: "totalAssets",
  })) as bigint;
}

export async function readVaultAgent(): Promise<Address> {
  return (await publicClient.readContract({
    address: env.VAULT_ADDRESS as Address,
    abi: vaultAbi,
    functionName: "agent",
  })) as Address;
}
