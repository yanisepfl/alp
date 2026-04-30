import type { Address, Hex } from "viem";

export type VolatilityProfile = "stable" | "low" | "mid" | "high";

export type AdapterKind = "v3" | "v4";

export interface PoolConfig {
  /** Human-readable pool label, used in logs. */
  label: string;
  /** Which adapter the pool routes through. Drives the monitor / executor
   *  branching for V4-specific reads (PositionManager + PoolManager). */
  kind: AdapterKind;
  /** LP pool registry key — hashed by `PoolRegistry.poolKey(...)`. */
  lpKey: Hex;
  /** URAdapter "router pool" registry key for swaps in this pair (only used
   *  on the rebalance swap step; V4 native-ETH swaps via UR aren't wired
   *  yet, so V4 pools keep this zero). */
  urKey: Hex;
  /** Pool tokens. For V4 native-ETH pools, `token0 = 0x000...000`. Sorting
   *  is `token0 < token1` (address(0) compares as smallest). */
  token0: Address;
  token1: Address;
  /** Decimals of token0 / token1 — used for human-friendly logging. */
  decimals0: number;
  decimals1: number;
  /** V3 fee tier (100/500/3000/10000) or V4 PoolKey.fee. V4 hooked pools
   *  use 0x800000 (DYNAMIC_FEE_FLAG). */
  fee: number;
  /** V3 tickSpacing matching the fee tier; V4 PoolKey.tickSpacing. */
  tickSpacing: number;
  /** V4 PoolKey.hooks — address(0) for V3 and unhooked V4 pools. */
  hooks: Address;
  /** Volatility profile drives target range width (see `widthForProfile`). */
  profile: VolatilityProfile;
}

export interface AgentConfig {
  rpcUrl: string;
  vaultAddress: Address;
  registryAddress: Address;
  v3AdapterAddress: Address;
  v4AdapterAddress: Address;
  urAdapterAddress: Address;
  /** V4 PositionManager — used by monitor to read V4 position liquidity + ranges. */
  v4PositionManagerAddress: Address;
  /** V4 PoolManager — used by monitor (extsload) to read pool tick. */
  v4PoolManagerAddress: Address;
  agentPrivateKey: Hex;
  /** Slippage tolerance applied to Trading API quotes, in basis points. */
  swapSlippageBps: number;
  /** Slippage tolerance applied to liquidity adds/removes, in basis points. */
  liquiditySlippageBps: number;
  /** Number of consecutive out-of-range observations before rebalancing. */
  hysteresisN: number;
  /** Hysteresis "got closer" threshold: if 2nd-obs distance is < this fraction
   * of 1st-obs distance, we wait another tick. */
  hysteresisCloserFraction: number;
  /** Base URL for the Uniswap Trading API (e.g. https://trade-api.gateway.uniswap.org). */
  tradingApiBase: string;
  /** Optional API key for the Trading API. Public free tier works without one. */
  tradingApiKey?: string;
  /** KeeperHub org API key (kh_…). When set together with `keeperHubDirectExec`,
   *  rebalance txs land via KH's Direct Execution API (Turnkey wallet signs). */
  keeperHubApiKey?: string;
  /** True iff we should route rebalance writes through KeeperHub instead of
   *  the local viem signer. Defaults to false; the worker still uses the
   *  hot key unless this is explicitly enabled. */
  keeperHubDirectExec: boolean;
  /** Pools the agent monitors. */
  pools: PoolConfig[];
}

/** Map a volatility profile to a position-range width.
 *
 *  - `stable`: returned in *ticks* (tight band for pegged pairs).
 *  - everything else: returned as a price-band fraction (e.g. 0.05 = ±5%).
 *
 *  Conversion to actual tick offsets happens in `planner.ts`, where pool
 *  spacing is also factored in.
 *
 *  Widths are intentionally tight: the whole point of the agent is to give
 *  the vault a *reason* to rebalance. Wider ranges = fewer rebalances =
 *  less to demo and less LP fee capture from staying near spot.
 */
export function widthForProfile(p: VolatilityProfile):
  | { kind: "ticks"; halfWidthTicks: number }
  | { kind: "pct"; halfWidthPct: number } {
  switch (p) {
    case "stable":
      return { kind: "ticks", halfWidthTicks: 2 };
    case "low":
      return { kind: "pct", halfWidthPct: 0.05 };
    case "mid":
      return { kind: "pct", halfWidthPct: 0.10 };
    case "high":
      return { kind: "pct", halfWidthPct: 0.20 };
  }
}

/** Build the agent config from environment / Worker secrets. */
export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const required = (key: string): string => {
    const v = env[key];
    if (!v) throw new Error(`missing env ${key}`);
    return v;
  };
  return {
    rpcUrl: required("BASE_RPC_URL"),
    vaultAddress: required("VAULT_ADDRESS") as Address,
    registryAddress: required("REGISTRY_ADDRESS") as Address,
    v3AdapterAddress: required("V3_ADAPTER_ADDRESS") as Address,
    v4AdapterAddress: required("V4_ADAPTER_ADDRESS") as Address,
    urAdapterAddress: required("UR_ADAPTER_ADDRESS") as Address,
    v4PositionManagerAddress: (env.V4_POSITION_MANAGER_ADDRESS ?? "0x7C5f5A4bBd8fD63184577525326123B519429bDc") as Address,
    v4PoolManagerAddress: (env.V4_POOL_MANAGER_ADDRESS ?? "0x498581fF718922c3f8e6A244956aF099B2652b2b") as Address,
    agentPrivateKey: required("AGENT_PRIVATE_KEY") as Hex,
    swapSlippageBps: Number(env.SWAP_SLIPPAGE_BPS ?? 50), // 0.50%
    liquiditySlippageBps: Number(env.LIQUIDITY_SLIPPAGE_BPS ?? 100), // 1.00%
    hysteresisN: Number(env.HYSTERESIS_N ?? 2),
    hysteresisCloserFraction: Number(env.HYSTERESIS_CLOSER_FRACTION ?? 0.5),
    tradingApiBase: env.TRADING_API_BASE ?? "https://trade-api.gateway.uniswap.org",
    tradingApiKey: env.TRADING_API_KEY,
    keeperHubApiKey: env.KEEPERHUB_API_KEY,
    keeperHubDirectExec: env.KEEPERHUB_DIRECT_EXEC === "true",
    // Pool list defaults empty; the local entrypoint can override via a JSON
    // file (see `agent/pools.local.json` for the format expected).
    pools: [],
  };
}

/** Parse the JSON pool config produced by `scripts/local-fork.sh`. */
export function parsePoolsJson(json: string): PoolConfig[] {
  const raw = JSON.parse(json) as Array<Omit<PoolConfig, "lpKey" | "urKey"> & { lpKey: string; urKey: string }>;
  return raw.map((p) => ({
    ...p,
    lpKey: p.lpKey as `0x${string}`,
    urKey: p.urKey as `0x${string}`,
  }));
}
