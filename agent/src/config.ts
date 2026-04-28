import type { Address, Hex } from "viem";

export type VolatilityProfile = "stable" | "low" | "mid" | "high";

export interface PoolConfig {
  /** Human-readable pool label, used in logs. */
  label: string;
  /** V3 LP pool registry key — hashed by `PoolRegistry.poolKey(...)`. */
  lpKey: Hex;
  /** URAdapter "router pool" registry key for swaps in this pair. */
  urKey: Hex;
  /** Sorted pool tokens (token0 < token1). */
  token0: Address;
  token1: Address;
  /** Decimals of token0 / token1 — used for human-friendly logging. */
  decimals0: number;
  decimals1: number;
  /** V3 fee tier (100 / 500 / 3000 / 10000). */
  fee: 100 | 500 | 3000 | 10000;
  /** V3 tickSpacing matching the fee tier. */
  tickSpacing: number;
  /** Volatility profile drives target range width (see `widthForProfile`). */
  profile: VolatilityProfile;
}

export interface AgentConfig {
  rpcUrl: string;
  vaultAddress: Address;
  registryAddress: Address;
  v3AdapterAddress: Address;
  urAdapterAddress: Address;
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
  /** Pools the agent monitors. */
  pools: PoolConfig[];
}

/** Map a volatility profile to a position-range width.
 *
 *  - `stable`: returned in *ticks* (tight band for pegged pairs).
 *  - everything else: returned as a price-band fraction (e.g. 0.10 = ±10%).
 *
 *  Conversion to actual tick offsets happens in `planner.ts`, where pool
 *  spacing is also factored in.
 */
export function widthForProfile(p: VolatilityProfile):
  | { kind: "ticks"; halfWidthTicks: number }
  | { kind: "pct"; halfWidthPct: number } {
  switch (p) {
    case "stable":
      return { kind: "ticks", halfWidthTicks: 8 };
    case "low":
      return { kind: "pct", halfWidthPct: 0.10 };
    case "mid":
      return { kind: "pct", halfWidthPct: 0.25 };
    case "high":
      return { kind: "pct", halfWidthPct: 0.50 };
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
    urAdapterAddress: required("UR_ADAPTER_ADDRESS") as Address,
    agentPrivateKey: required("AGENT_PRIVATE_KEY") as Hex,
    swapSlippageBps: Number(env.SWAP_SLIPPAGE_BPS ?? 50), // 0.50%
    liquiditySlippageBps: Number(env.LIQUIDITY_SLIPPAGE_BPS ?? 100), // 1.00%
    hysteresisN: Number(env.HYSTERESIS_N ?? 2),
    hysteresisCloserFraction: Number(env.HYSTERESIS_CLOSER_FRACTION ?? 0.5),
    tradingApiBase: env.TRADING_API_BASE ?? "https://trade-api.gateway.uniswap.org",
    tradingApiKey: env.TRADING_API_KEY,
    // Pool list is populated post-deployment via `bootstrapPools.ts`.
    pools: [],
  };
}
