// Uniswap SDK consultation — read-side brain layer that informs the
// keeper's amount/range/slippage math without touching the write path.
// Replaces the REST Liquidity API wrapper (uniswapApi.ts) after the
// gateway returned 403/400 even with a valid dashboard key. The SDK
// computes all Position math locally — no API auth needed.
//
// Surface mirrors the prior wrapper so executor.ts plumbing is
// unchanged: consultDecrease, consultCreate, summariseConsultation,
// and the LiquidityApiResult shape.
//
// What the SDK gives us:
//   - V3:  Pool + Position from on-chain state, Position.fromAmounts
//          for optimal mint params, mintAmountsWithSlippage for min
//          amounts after slippage, burnAmountsWithSlippage for
//          expected decrease outputs.
//   - V4:  Same Position shape with hookAddress + tickSpacing.
//
// The actuator (vault adapters) still owns the write path. Consultation
// surfaces in the agent feed and informs narration; v2 will use the
// recommended amounts as input to vault.executeAddLiquidity sizing.
//
// Failure mode: any SDK throw is caught and surfaced as
// `{ ok: false, error }`. Callers degrade gracefully — narration says
// "unavailable (sdk error: ...)" and the rebalance proceeds with our
// hand-rolled local math.

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
  /** 0 for SDK paths (no HTTP). Kept for API parity with the old
   *  REST wrapper so executor + scan plumbing didn't need to change. */
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

/** ERC20 decimals cache. Each token decimals() read is a single
 *  view call; cached at module level so repeated consultations don't
 *  hit the RPC again. Native-ETH (V4 sentinel 0x0) is hard-coded to 18. */
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

/** Build a sdk-core `Currency` for a token address. ERC20s become
 *  `Token`; the V4 native-ETH sentinel becomes `Ether.onChain(8453)`
 *  so the V4 SDK accepts it as currency0. */
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

/** Read V3 pool spot state needed to construct the SDK Pool entity.
 *  Single composite call: get the pool address from the factory, then
 *  read slot0 + liquidity off the pool contract.
 */
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

/** Read V4 pool spot state via PoolManager.extsload. Mirrors the
 *  pattern in monitor.ts — same poolId/slot0 derivation, plus an
 *  extra read for liquidity (offset 3 of the pool struct). */
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
  // Pool liquidity sits at slot offset 3 (Slot0 packed at 0, fee growth
  // globals at 1+2, then liquidity uint128). PoolManager stores the
  // pool struct hashed at keccak(poolId, slot 6); add 3 for liquidity.
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
    // Pool needs a non-zero liquidity to validate price/tick bounds in
    // some paths; on-chain liquidity is what we read.
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
  /** Position's tickLower / tickUpper / liquidity at observation time. */
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/** Compute expected (amount0, amount1) returned when burning the
 *  position. Wraps Position.burnAmountsWithSlippage for the min path
 *  and Position.amount0/.amount1 for the expected midpoint. */
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
    // burnAmountsWithSlippage: minimum out after slippage (the floor we'd pass
    // as amount0Min/amount1Min). expected midpoint is position.amount0/1.
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
  /** Target range — what we're rebalancing INTO. */
  tickLower: number;
  tickUpper: number;
  /** Maximum amounts the keeper has available to commit. The SDK picks
   *  the optimal split at current spot and returns the amounts that
   *  ratio-match the new range. */
  maxAmount0: bigint;
  maxAmount1: bigint;
}

/** Compute optimal mint amounts at the new range given available
 *  balances. Wraps Position.fromAmounts → mintAmountsWithSlippage.
 *  The recommended (amount0, amount1) is what V3/V4 mint will actually
 *  consume; the rest is refunded by V3 (V4 needs exact). */
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

/** Render a one-line consultation summary suitable for the agent feed.
 *  Always TRUE — never fabricates numbers. On error, surfaces the
 *  message verbatim so the failure mode is visible to Sherpa users. */
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
  // We don't know exact decimals here without re-reading; rely on the
  // symbol map (USDC/USDT=6, cbBTC=8, ETH=18). Fallback to 18.
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
  // Spot price reads as "token1 per 1 token0" by SDK convention. Surface
  // it both ways so narrator can pick the natural direction (e.g. "ETH at
  // 2547 USDC" rather than "USDC at 0.000392 ETH").
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
