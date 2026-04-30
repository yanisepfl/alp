// Position observer. Ports the V3/V4 read patterns from
// ~/alp/agent/src/monitor.ts onto the keeper's TrackedPool shape.
//
// Per-tick output: one PositionObservation per tracked position across all
// active pools. Range policies consume the in-range/distance fields; vol
// policies consume the currentTick.

import { encodeAbiParameters, keccak256, type Address } from "viem";

import { npmAbi, v3FactoryAbi, v3PoolAbi, v4PoolManagerAbi, v4PositionManagerAbi } from "./abi";
import { publicClient, V3_FACTORY, V3_NPM, V4_POOL_MANAGER, V4_POOLS_SLOT, V4_POSITION_MANAGER } from "./chain";
import { readPositionIds, type TrackedPool } from "./vault";

export interface PositionObservation {
  pool: TrackedPool;
  positionId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  currentTick: number;
  inRange: boolean;
  /** Absolute tick distance to the nearest range edge, 0 when in-range. */
  outOfRangeDistance: number;
}

export async function observe(pools: readonly TrackedPool[]): Promise<PositionObservation[]> {
  const out: PositionObservation[] = [];
  for (const pool of pools) {
    const ids = await readPositionIds(pool.lpKey);
    if (ids.length === 0) continue;
    if (pool.kind === "v3") {
      const obs = await observeV3(pool, ids);
      out.push(...obs);
    } else {
      const obs = await observeV4(pool, ids);
      out.push(...obs);
    }
  }
  return out;
}

async function observeV3(pool: TrackedPool, ids: readonly bigint[]): Promise<PositionObservation[]> {
  const poolAddr = (await publicClient.readContract({
    address: V3_FACTORY,
    abi: v3FactoryAbi,
    functionName: "getPool",
    args: [pool.token0, pool.token1, pool.fee],
  })) as Address;
  const slot0 = (await publicClient.readContract({
    address: poolAddr,
    abi: v3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  const currentTick = slot0[1];

  const out: PositionObservation[] = [];
  for (const positionId of ids) {
    const pos = (await publicClient.readContract({
      address: V3_NPM,
      abi: npmAbi,
      functionName: "positions",
      args: [positionId],
    })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
    const tickLower = pos[5];
    const tickUpper = pos[6];
    const liquidity = pos[7];
    out.push(buildObs(pool, positionId, tickLower, tickUpper, liquidity, currentTick));
  }
  return out;
}

async function observeV4(pool: TrackedPool, ids: readonly bigint[]): Promise<PositionObservation[]> {
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
    address: V4_POOL_MANAGER,
    abi: v4PoolManagerAbi,
    functionName: "extsload",
    args: [slot0Slot],
  })) as `0x${string}`;
  const slot0Big = BigInt(slot0Raw);
  // Layout: bits 0..159 = sqrtPriceX96, bits 160..183 = tick (int24).
  const tickMask = (1n << 24n) - 1n;
  const tickRaw = (slot0Big >> 160n) & tickMask;
  const currentTick = Number(tickRaw >= 1n << 23n ? tickRaw - (1n << 24n) : tickRaw);

  const out: PositionObservation[] = [];
  for (const positionId of ids) {
    const liquidity = (await publicClient.readContract({
      address: V4_POSITION_MANAGER,
      abi: v4PositionManagerAbi,
      functionName: "getPositionLiquidity",
      args: [positionId],
    })) as bigint;
    const [, info] = (await publicClient.readContract({
      address: V4_POSITION_MANAGER,
      abi: v4PositionManagerAbi,
      functionName: "getPoolAndPositionInfo",
      args: [positionId],
    })) as readonly [unknown, bigint];
    // PositionInfo packs: bits 8..31 tickLower, 32..55 tickUpper.
    const tlRaw = (info >> 8n) & tickMask;
    const tuRaw = (info >> 32n) & tickMask;
    const tickLower = Number(tlRaw >= 1n << 23n ? tlRaw - (1n << 24n) : tlRaw);
    const tickUpper = Number(tuRaw >= 1n << 23n ? tuRaw - (1n << 24n) : tuRaw);
    out.push(buildObs(pool, positionId, tickLower, tickUpper, liquidity, currentTick));
  }
  return out;
}

function buildObs(
  pool: TrackedPool,
  positionId: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  currentTick: number,
): PositionObservation {
  const inRange = currentTick >= tickLower && currentTick < tickUpper;
  const outOfRangeDistance = inRange
    ? 0
    : currentTick < tickLower
      ? tickLower - currentTick
      : currentTick - (tickUpper - 1);
  return { pool, positionId, tickLower, tickUpper, liquidity, currentTick, inRange, outOfRangeDistance };
}
