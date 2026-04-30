import { encodeAbiParameters, keccak256, type Address, type PublicClient } from "viem";

import { npmAbi, v3FactoryAbi, v3PoolAbi, v4PoolManagerAbi, v4PositionManagerAbi, vaultAbi } from "./abi.js";
import type { AgentConfig, PoolConfig } from "./config.js";

const V3_FACTORY: Address = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const V3_NPM: Address = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";

/** Storage slot index of the `pools` mapping inside V4 PoolManager.
 *  Cross-checked against v4-core StateLibrary. */
const V4_POOLS_SLOT = 6n;

export interface PositionSnapshot {
  pool: PoolConfig;
  positionId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  currentTick: number;
  /** True iff `tickLower <= currentTick < tickUpper` (Uniswap in-range convention). */
  inRange: boolean;
  /** Absolute tick distance to the nearest range edge. Zero when in-range. */
  outOfRangeDistance: number;
}

/** Read every tracked position the agent might want to act on. */
export async function snapshotPositions(client: PublicClient, config: AgentConfig): Promise<PositionSnapshot[]> {
  const out: PositionSnapshot[] = [];

  for (const pool of config.pools) {
    const positionIds = await client.readContract({
      address: config.vaultAddress,
      abi: vaultAbi,
      functionName: "getPositionIds",
      args: [pool.lpKey],
    });
    if (positionIds.length === 0) continue;

    const reads = pool.kind === "v3" ? readV3Positions : readV4Positions;
    const snapshots = await reads(client, config, pool, positionIds as readonly bigint[]);
    out.push(...snapshots);
  }

  return out;
}

async function readV3Positions(
  client: PublicClient,
  _config: AgentConfig,
  pool: PoolConfig,
  positionIds: readonly bigint[],
): Promise<PositionSnapshot[]> {
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

  const out: PositionSnapshot[] = [];
  for (const positionId of positionIds) {
    const pos = await client.readContract({
      address: V3_NPM,
      abi: npmAbi,
      functionName: "positions",
      args: [positionId],
    });
    out.push(buildSnapshot(pool, positionId, pos[5], pos[6], pos[7], currentTick));
  }
  return out;
}

async function readV4Positions(
  client: PublicClient,
  config: AgentConfig,
  pool: PoolConfig,
  positionIds: readonly bigint[],
): Promise<PositionSnapshot[]> {
  // V4 PoolKey identity → PoolId (keccak of the abi-encoded struct).
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [pool.token0, pool.token1, pool.fee, pool.tickSpacing, pool.hooks],
    ),
  );

  // Pool storage slot inside V4 PoolManager: keccak(abi.encode(poolId, POOLS_SLOT)).
  // slot0 sits at offset 0 of the pool struct, packed:
  //   bits 0..159   = sqrtPriceX96 (uint160)
  //   bits 160..183 = tick (int24)
  //   bits 184..207 = protocolFee (uint24)
  //   bits 208..231 = lpFee (uint24)
  const slot0Slot = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, V4_POOLS_SLOT]),
  );
  const slot0Raw = await client.readContract({
    address: config.v4PoolManagerAddress,
    abi: v4PoolManagerAbi,
    functionName: "extsload",
    args: [slot0Slot],
  });
  const slot0Big = BigInt(slot0Raw);
  // Extract the int24 tick (sign-extend manually).
  const tickMask = (1n << 24n) - 1n;
  const tickRaw = (slot0Big >> 160n) & tickMask;
  const currentTick = Number(tickRaw >= 1n << 23n ? tickRaw - (1n << 24n) : tickRaw);

  const out: PositionSnapshot[] = [];
  for (const positionId of positionIds) {
    const liquidity = await client.readContract({
      address: config.v4PositionManagerAddress,
      abi: v4PositionManagerAbi,
      functionName: "getPositionLiquidity",
      args: [positionId],
    });
    const [, info] = await client.readContract({
      address: config.v4PositionManagerAddress,
      abi: v4PositionManagerAbi,
      functionName: "getPoolAndPositionInfo",
      args: [positionId],
    });
    // PositionInfo packs (low → high):
    //   bits 0..7    = subscriber/dirty flags (1 byte)
    //   bits 8..31   = tickLower (int24)
    //   bits 32..55  = tickUpper (int24)
    //   bits 56..255 = upper part of poolId (truncated; not used here)
    const tlRaw = (info >> 8n) & tickMask;
    const tuRaw = (info >> 32n) & tickMask;
    const tickLower = Number(tlRaw >= 1n << 23n ? tlRaw - (1n << 24n) : tlRaw);
    const tickUpper = Number(tuRaw >= 1n << 23n ? tuRaw - (1n << 24n) : tuRaw);
    out.push(buildSnapshot(pool, positionId, tickLower, tickUpper, liquidity, currentTick));
  }
  return out;
}

function buildSnapshot(
  pool: PoolConfig,
  positionId: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  currentTick: number,
): PositionSnapshot {
  const inRange = currentTick >= tickLower && currentTick < tickUpper;
  const outOfRangeDistance = inRange ? 0 : currentTick < tickLower ? tickLower - currentTick : currentTick - (tickUpper - 1);
  return { pool, positionId, tickLower, tickUpper, liquidity, currentTick, inRange, outOfRangeDistance };
}
