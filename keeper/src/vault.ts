import type { Address } from "viem";

import { vaultAbi, registryAbi } from "./abi";
import { publicClient } from "./chain";
import { env } from "./env";

const REGISTRY_DEPLOY_BLOCK = 45356000n;
const LOG_CHUNK_BLOCKS = 10000n;

export type AdapterKind = "v3" | "v4";
export type VolatilityProfile = "stable" | "low" | "mid" | "high";

export interface TrackedPool {
  lpKey: `0x${string}`;
  /** URAdapter pool key paired with the LP pool. Required for executeSwap
   *  routing — the swap pool's fee/tickSpacing/hooks are independent of
   *  the LP pool's, so it's discovered via PoolAdded event scan. */
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
  profile: VolatilityProfile;
}

const TOKEN_SYMBOL: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x4200000000000000000000000000000000000006": "ETH",
  "0x0000000000000000000000000000000000000000": "ETH",
};

function tokenSymbol(addr: Address): string {
  return TOKEN_SYMBOL[addr.toLowerCase()] ?? addr.slice(0, 8);
}

function defaultProfile(token0: Address, token1: Address): VolatilityProfile {
  const stables = new Set(["USDC", "USDT", "DAI"]);
  if (stables.has(tokenSymbol(token0)) && stables.has(tokenSymbol(token1))) return "stable";
  return "mid";
}

const V4_ADAPTER: Address = "0xB6871C8cd995fF015DBa7373b371426E80cBBCF0";
export const UR_ADAPTER: Address = "0x6BeE052D58Ba95bae9fd23d81a2B96145095a962";

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

const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

function urMatchKey(token0: Address, token1: Address): string[] {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const keys = [`${t0}:${t1}`];
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

    let urKey: `0x${string}` | undefined;
    for (const k of urMatchKey(tup.token0, tup.token1)) {
      const found = urMap.get(k);
      if (found) { urKey = found; break; }
    }
    if (!urKey) {
      throw new Error(
        `[vault.loadPools] LP pool ${sym0}/${sym1} (lpKey=${key}) has no URAdapter mate registered. ` +
        `Register a URAdapter pool with matching tokens via PoolRegistry.addPool, ` +
        `or remove this LP pool from the active set.`,
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
