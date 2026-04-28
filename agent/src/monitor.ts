import { type Address, type PublicClient } from "viem";

import { npmAbi, v3FactoryAbi, v3PoolAbi, vaultAbi } from "./abi.js";
import type { AgentConfig, PoolConfig } from "./config.js";

const V3_FACTORY: Address = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const V3_NPM: Address = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";

export interface PositionSnapshot {
  pool: PoolConfig;
  positionId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  currentTick: number;
  /** True iff `tickLower <= currentTick < tickUpper` (V3 in-range convention). */
  inRange: boolean;
  /** Absolute tick distance to the nearest range edge. Zero when in-range. */
  outOfRangeDistance: number;
}

/** Read every tracked position the agent might want to act on. */
export async function snapshotPositions(
  client: PublicClient,
  config: AgentConfig,
): Promise<PositionSnapshot[]> {
  const out: PositionSnapshot[] = [];

  for (const pool of config.pools) {
    const positionIds = await client.readContract({
      address: config.vaultAddress,
      abi: vaultAbi,
      functionName: "getPositionIds",
      args: [pool.lpKey],
    });

    if (positionIds.length === 0) continue;

    const poolAddr = await client.readContract({
      address: V3_FACTORY,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [pool.token0, pool.token1, pool.fee],
    });

    const slot0 = await client.readContract({
      address: poolAddr,
      abi: v3PoolAbi,
      functionName: "slot0",
    });
    const currentTick = slot0[1];

    for (const positionId of positionIds) {
      const pos = await client.readContract({
        address: V3_NPM,
        abi: npmAbi,
        functionName: "positions",
        args: [positionId],
      });
      const tickLower = pos[5];
      const tickUpper = pos[6];
      const liquidity = pos[7];

      const inRange = currentTick >= tickLower && currentTick < tickUpper;
      const outOfRangeDistance = inRange
        ? 0
        : currentTick < tickLower
          ? tickLower - currentTick
          : currentTick - (tickUpper - 1);

      out.push({
        pool,
        positionId,
        tickLower,
        tickUpper,
        liquidity,
        currentTick,
        inRange,
        outOfRangeDistance,
      });
    }
  }

  return out;
}
