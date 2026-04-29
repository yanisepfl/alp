/** TypeScript port of Uniswap's TickMath + LiquidityAmounts helpers used by
 *  the V4 add-liquidity sizing path. The on-chain V4 PositionManager calls
 *  `LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper,
 *  amount0, amount1)` and reverts with `InsufficientLiquidityComputed` when
 *  that returns 0. The agent must therefore pre-compute liquidity locally and
 *  feed back the matching `(amount0, amount1)` so the on-chain quote is
 *  guaranteed non-zero.
 *
 *  Only the math we actually need is ported: `getSqrtRatioAtTick` and the
 *  three branches of `getLiquidityForAmounts` / `getAmountsForLiquidity`. The
 *  algorithm is bit-for-bit identical to v4-core/TickMath.sol (the constants
 *  are the rounded magic numbers from the canonical implementation) and to
 *  v4-periphery/LiquidityAmounts.sol.
 */

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

const MAX_TICK = 887272;

/** Bit-exact port of v4-core's `TickMath.getSqrtPriceAtTick`. */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > BigInt(MAX_TICK)) throw new Error(`tick out of range: ${tick}`);

  let ratio: bigint =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) {
    // div(type(uint256).max, ratio)
    const MAX_UINT256 = (1n << 256n) - 1n;
    ratio = MAX_UINT256 / ratio;
  }

  // shr(32, add(price, sub(shl(32, 1), 1))) — round up Q128.128 → Q128.96.
  const sqrtPriceX96 = (ratio + ((1n << 32n) - 1n)) >> 32n;
  return sqrtPriceX96;
}

/** mulDiv that rounds down. JS bigint has no mulmod gymnastics; for our 256-bit
 *  range this trivially fits since intermediates use 512 bits worth of bigint. */
function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  return (a * b) / denom;
}

/** Liquidity amount given a token0 reserve and a price range (assumes
 *  sqrtRatioAX96 < sqrtRatioBX96; the caller ensures the swap). */
function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  // intermediate = sqrtA * sqrtB / Q96
  const intermediate = mulDiv(sqrtA, sqrtB, Q96);
  return mulDiv(amount0, intermediate, sqrtB - sqrtA);
}

/** Liquidity amount given a token1 reserve and a price range. */
function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(amount1, Q96, sqrtB - sqrtA);
}

/** Bit-for-bit port of `LiquidityAmounts.getLiquidityForAmounts`. Returns the
 *  largest `liquidity` consumable from the given (amount0, amount1). */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
  } else if (sqrtPriceX96 < sqrtRatioBX96) {
    const l0 = getLiquidityForAmount0(sqrtPriceX96, sqrtRatioBX96, amount0);
    const l1 = getLiquidityForAmount1(sqrtRatioAX96, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  } else {
    return getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
  }
}

function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  // (liquidity << 96) * (sqrtB - sqrtA) / sqrtB / sqrtA
  return mulDiv(liquidity << 96n, sqrtB - sqrtA, sqrtB) / sqrtA;
}

function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

/** Inverse of `getLiquidityForAmounts`: how much (amount0, amount1) does
 *  `liquidity` actually consume at the given spot. We use this to back-compute
 *  the exact desired amounts to forward to the on-chain quote so it matches. */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    amount0 = getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
  } else if (sqrtPriceX96 < sqrtRatioBX96) {
    amount0 = getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioBX96, liquidity);
    amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtPriceX96, liquidity);
  } else {
    amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
  }
  return { amount0, amount1 };
}

// Suppress "unused" warning if Q192 is reserved for future helpers.
void Q192;
