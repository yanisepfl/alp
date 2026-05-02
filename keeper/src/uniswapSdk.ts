import { Ether, Percent, Token, type Currency } from "@uniswap/sdk-core";
import { Pool as V3Pool, Position as V3Position, TickMath } from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position } from "@uniswap/v4-sdk";
import type { Address } from "viem";

import { erc20BalanceAbi, v3PoolAbi, v4PoolManagerAbi } from "./abi";
import { publicClient, V3_FACTORY, V4_POOL_MANAGER, V4_POOLS_SLOT } from "./chain";
import { env } from "./env";
import type { TrackedPool } from "./vault";

const CHAIN_ID = 8453;

export interface LiquidityApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
  status: number;
}

export interface ConsultationResponse {
  /** Optimal/expected amount0 in raw units (token0 base units). */
  amount0?: string;
  /** Optimal/expected amount1 in raw units (token1 base units). */
  amount1?: string;
  /** Liquidity for the position (uint128 as decimal string). */
  liquidity?: string;
  /** Minimum amounts after slippage tolerance applied. Same units. */
  amount0Min?: string;
  amount1Min?: string;
  /** Slippage tolerance in basis points (env.LIQUIDITY_SLIPPAGE_BPS). */
  slippageBps?: number;
  /** Tick range. Echoed back so the consultation entry self-describes. */
  tickLower?: number;
  tickUpper?: number;
  /** Pool spot tick at consultation time. */
  poolTick?: number;
  /** Symbols for the amount lines so narration can display "0.148 USDC"
   *  rather than raw uint256 strings without the consumer needing to
   *  re-derive decimals. */
  symbol0?: string;
  symbol1?: string;
  /** Human-readable spot price of token0 in token1 units, computed by the
   *  SDK Pool entity. E.g. "0.99987" for USDC/USDT, "2547.13" for ETH/USDC. */
  token0Price?: string;
  /** Inverse — token1 priced in token0. */
  token1Price?: string;
  /** Pool fee tier in basis points (V3 fixed, V4 dynamic snapshot). */
  feeBps?: number;
  /** SDK protocol version actually used for this consultation. */
  protocol?: "v3" | "v4";
}

const decimalsCache = new Map<string, number>();

async function getDecimals(token: Address): Promise<number> {
  const k = token.toLowerCase();
  if (k === "0x0000000000000000000000000000000000000000") return 18;
  const cached = decimalsCache.get(k);
  if (cached !== undefined) return cached;
  const decimals = (await publicClient.readContract({
    address: token,
    abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }],
    functionName: "decimals",
  })) as number;
  decimalsCache.set(k, decimals);
  return decimals;
}

async function toCurrency(token: Address, symbol: string): Promise<Currency> {
  if (token === "0x0000000000000000000000000000000000000000") {
    return Ether.onChain(CHAIN_ID);
  }
  const decimals = await getDecimals(token);
  return new Token(CHAIN_ID, token, decimals, symbol);
}

const SYMBOL: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x4200000000000000000000000000000000000006": "ETH",
  "0x0000000000000000000000000000000000000000": "ETH",
};
function sym(addr: Address): string {
  return SYMBOL[addr.toLowerCase()] ?? addr.slice(0, 8);
}

async function readV3PoolState(pool: TrackedPool): Promise<{
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  poolAddress: Address;
}> {
  const factoryAbi = [{
    type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  }] as const;
  const poolAddress = (await publicClient.readContract({
    address: V3_FACTORY, abi: factoryAbi, functionName: "getPool",
    args: [pool.token0, pool.token1, pool.fee],
  })) as Address;
  const slot0 = (await publicClient.readContract({
    address: poolAddress, abi: v3PoolAbi, functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  const liquidityAbi = [{
    type: "function", name: "liquidity", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint128" }],
  }] as const;
  const liquidity = (await publicClient.readContract({
    address: poolAddress, abi: liquidityAbi, functionName: "liquidity",
  })) as bigint;
  return { sqrtPriceX96: slot0[0], tick: slot0[1], liquidity, poolAddress };
}

async function readV4PoolState(pool: TrackedPool): Promise<{ sqrtPriceX96: bigint; tick: number; liquidity: bigint }> {
  const { encodeAbiParameters, keccak256 } = await import("viem");
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" }, { type: "address" }, { type: "uint24" },
        { type: "int24" }, { type: "address" },
      ],
      [pool.token0, pool.token1, pool.fee, pool.tickSpacing, pool.hooks],
    ),
  );
  const slot0Slot = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, V4_POOLS_SLOT]),
  );
  const slot0Raw = (await publicClient.readContract({
    address: V4_POOL_MANAGER, abi: v4PoolManagerAbi, functionName: "extsload", args: [slot0Slot],
  })) as `0x${string}`;
  const slot0Big = BigInt(slot0Raw);
  const tickMask = (1n << 24n) - 1n;
  const sqrtPriceX96 = slot0Big & ((1n << 160n) - 1n);
  const tickRaw = (slot0Big >> 160n) & tickMask;
  const tick = Number(tickRaw >= 1n << 23n ? tickRaw - (1n << 24n) : tickRaw);
  // Liquidity uint128 sits at slot offset +3 of the Pool struct
  // (slot0 packed at 0, fee growth globals at 1+2, liquidity at 3).
  const liquiditySlot = (BigInt(slot0Slot) + 3n).toString(16).padStart(64, "0");
  const liquidityRaw = (await publicClient.readContract({
    address: V4_POOL_MANAGER, abi: v4PoolManagerAbi, functionName: "extsload",
    args: [`0x${liquiditySlot}`],
  })) as `0x${string}`;
  const liquidity = BigInt(liquidityRaw) & ((1n << 128n) - 1n);
  return { sqrtPriceX96, tick, liquidity };
}

async function buildV3Pool(pool: TrackedPool): Promise<{ pool: V3Pool; tick: number }> {
  const state = await readV3PoolState(pool);
  const t0 = (await toCurrency(pool.token0, sym(pool.token0))) as Token;
  const t1 = (await toCurrency(pool.token1, sym(pool.token1))) as Token;
  const sdkPool = new V3Pool(
    t0, t1, pool.fee,
    state.sqrtPriceX96.toString(),
    state.liquidity === 0n ? "1" : state.liquidity.toString(),
    state.tick,
  );
  return { pool: sdkPool, tick: state.tick };
}

async function buildV4Pool(pool: TrackedPool): Promise<{ pool: V4Pool; tick: number }> {
  const state = await readV4PoolState(pool);
  const c0 = await toCurrency(pool.token0, sym(pool.token0));
  const c1 = await toCurrency(pool.token1, sym(pool.token1));
  const sdkPool = new V4Pool(
    c0, c1, pool.fee, pool.tickSpacing, pool.hooks,
    state.sqrtPriceX96.toString(),
    state.liquidity === 0n ? "1" : state.liquidity.toString(),
    state.tick,
  );
  return { pool: sdkPool, tick: state.tick };
}

const slippageTolerance = (): Percent =>
  new Percent(env.LIQUIDITY_SLIPPAGE_BPS, 10_000);

export interface ConsultDecreaseArgs {
  pool: TrackedPool;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/** Expected (amount0, amount1) returned when burning the position,
 *  with slippage-floor amounts. */
export async function consultDecrease(args: ConsultDecreaseArgs): Promise<LiquidityApiResult<ConsultationResponse>> {
  const start = performance.now();
  try {
    const { pool: sdkPool, tick } = args.pool.kind === "v4"
      ? await buildV4Pool(args.pool)
      : await buildV3Pool(args.pool);

    const Pos = args.pool.kind === "v4" ? V4Position : V3Position;
    const position = new (Pos as typeof V3Position)({
      pool: sdkPool as V3Pool,
      liquidity: args.liquidity.toString(),
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
    });

    const slippage = slippageTolerance();
    const burn = position.burnAmountsWithSlippage(slippage);
    const data: ConsultationResponse = {
      amount0: position.amount0.quotient.toString(),
      amount1: position.amount1.quotient.toString(),
      amount0Min: burn.amount0.toString(),
      amount1Min: burn.amount1.toString(),
      liquidity: args.liquidity.toString(),
      slippageBps: env.LIQUIDITY_SLIPPAGE_BPS,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      poolTick: tick,
      symbol0: sym(args.pool.token0),
      symbol1: sym(args.pool.token1),
      token0Price: (sdkPool as V3Pool).token0Price.toSignificant(6),
      token1Price: (sdkPool as V3Pool).token1Price.toSignificant(6),
      feeBps: args.pool.fee / 100,
      protocol: args.pool.kind,
    };
    return { ok: true, data, latencyMs: Math.round(performance.now() - start), status: 0 };
  } catch (e) {
    return {
      ok: false,
      error: `sdk error: ${(e as Error).message}`,
      latencyMs: Math.round(performance.now() - start),
      status: 0,
    };
  }
}

export interface ConsultCreateArgs {
  pool: TrackedPool;
  tickLower: number;
  tickUpper: number;
  maxAmount0: bigint;
  maxAmount1: bigint;
}

/** Optimal mint amounts at the new range given available balances.
 *  The SDK picks the spot-ratio split; surplus is refunded by V3. */
export async function consultCreate(args: ConsultCreateArgs): Promise<LiquidityApiResult<ConsultationResponse>> {
  const start = performance.now();
  try {
    const { pool: sdkPool, tick } = args.pool.kind === "v4"
      ? await buildV4Pool(args.pool)
      : await buildV3Pool(args.pool);

    const Pos = args.pool.kind === "v4" ? V4Position : V3Position;
    const position = (Pos as typeof V3Position).fromAmounts({
      pool: sdkPool as V3Pool,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      amount0: args.maxAmount0.toString(),
      amount1: args.maxAmount1.toString(),
      useFullPrecision: true,
    });

    const slippage = slippageTolerance();
    const mints = position.mintAmountsWithSlippage(slippage);
    const data: ConsultationResponse = {
      amount0: position.amount0.quotient.toString(),
      amount1: position.amount1.quotient.toString(),
      liquidity: position.liquidity.toString(),
      amount0Min: mints.amount0.toString(),
      amount1Min: mints.amount1.toString(),
      slippageBps: env.LIQUIDITY_SLIPPAGE_BPS,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      poolTick: tick,
      symbol0: sym(args.pool.token0),
      symbol1: sym(args.pool.token1),
      token0Price: (sdkPool as V3Pool).token0Price.toSignificant(6),
      token1Price: (sdkPool as V3Pool).token1Price.toSignificant(6),
      feeBps: args.pool.fee / 100,
      protocol: args.pool.kind,
    };
    return { ok: true, data, latencyMs: Math.round(performance.now() - start), status: 0 };
  } catch (e) {
    return {
      ok: false,
      error: `sdk error: ${(e as Error).message}`,
      latencyMs: Math.round(performance.now() - start),
      status: 0,
    };
  }
}

/** One-line consultation summary suitable for the agent feed. */
export function summariseConsultation(label: string, r: LiquidityApiResult<ConsultationResponse>): string {
  if (!r.ok) {
    return `Uniswap SDK /${label}: unavailable (${r.error}) — falling back to local math.`;
  }
  const d = r.data!;
  const fmt = (raw: string | undefined, decimals: number, suffix: string): string => {
    if (raw === undefined) return "?";
    const big = BigInt(raw);
    const div = 10n ** BigInt(decimals);
    const whole = big / div;
    const frac = (big % div).toString().padStart(decimals, "0").slice(0, Math.min(6, decimals));
    return `${whole.toString()}.${frac} ${suffix}`;
  };
  const decimalsFor = (s: string | undefined): number =>
    s === "USDC" || s === "USDT" ? 6 : s === "cbBTC" ? 8 : 18;
  const dec0 = decimalsFor(d.symbol0);
  const dec1 = decimalsFor(d.symbol1);
  const a0 = fmt(d.amount0, dec0, d.symbol0 ?? "tok0");
  const a1 = fmt(d.amount1, dec1, d.symbol1 ?? "tok1");
  const min0 = fmt(d.amount0Min, dec0, d.symbol0 ?? "tok0");
  const min1 = fmt(d.amount1Min, dec1, d.symbol1 ?? "tok1");
  const range = `[${d.tickLower}, ${d.tickUpper}]`;
  const slip = d.slippageBps !== undefined ? `${d.slippageBps}bps slippage` : "";
  const priceLine = d.token0Price && d.token1Price && d.symbol0 && d.symbol1
    ? `, spot=${d.token0Price} ${d.symbol1}/${d.symbol0} (${d.token1Price} ${d.symbol0}/${d.symbol1})`
    : "";
  const protoFee = d.protocol && d.feeBps !== undefined
    ? `, ${d.protocol.toUpperCase()} ${d.feeBps}bps`
    : "";
  return (
    `Uniswap ${d.protocol === "v4" ? "V4" : "V3"} SDK /${label} (${r.latencyMs}ms, pool tick ${d.poolTick}, range ${range}, ${slip}${protoFee}${priceLine}): ` +
    `amount0=${a0}, amount1=${a1}, liquidity=${d.liquidity ?? "?"}, ` +
    `min0=${min0}, min1=${min1}.`
  );
}
