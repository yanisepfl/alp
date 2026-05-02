export const vaultAbi = [
  {
    type: "function", name: "agent", stateMutability: "view",
    inputs: [], outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "asset", stateMutability: "view",
    inputs: [], outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "totalAssets", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "getActivePools", stateMutability: "view",
    inputs: [], outputs: [{ type: "bytes32[]" }],
  },
  {
    type: "function", name: "getPositionIds", stateMutability: "view",
    inputs: [{ name: "poolKey", type: "bytes32" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function", name: "poolValueExternal", stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "executeAddLiquidity", stateMutability: "nonpayable",
    inputs: [
      { name: "poolKey", type: "bytes32" },
      { name: "amount0Desired", type: "uint256" },
      { name: "amount1Desired", type: "uint256" },
      { name: "amount0Min", type: "uint256" },
      { name: "amount1Min", type: "uint256" },
      { name: "extra", type: "bytes" },
    ],
    outputs: [
      { name: "positionId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0Used", type: "uint256" },
      { name: "amount1Used", type: "uint256" },
    ],
  },
  {
    type: "function", name: "executeRemoveLiquidity", stateMutability: "nonpayable",
    inputs: [
      { name: "poolKey", type: "bytes32" },
      { name: "positionId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0Min", type: "uint256" },
      { name: "amount1Min", type: "uint256" },
      { name: "extra", type: "bytes" },
    ],
    outputs: [
      { name: "amount0Out", type: "uint256" },
      { name: "amount1Out", type: "uint256" },
      { name: "burned", type: "bool" },
    ],
  },
  {
    type: "function", name: "executeSwap", stateMutability: "nonpayable",
    inputs: [
      { name: "poolKey", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "extra", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const registryAbi = [
  {
    type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{
      type: "tuple",
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
    }],
  },
  {
    type: "function", name: "poolKey", stateMutability: "pure",
    inputs: [
      { name: "adapter", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "isPoolKnown", stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export const vaultEventsAbi = [
  {
    type: "event", name: "LiquidityRemoved",
    inputs: [
      { name: "poolKey", type: "bytes32", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "amount0Out", type: "uint256", indexed: false },
      { name: "amount1Out", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "LiquidityAdded",
    inputs: [
      { name: "poolKey", type: "bytes32", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "amount0Used", type: "uint256", indexed: false },
      { name: "amount1Used", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Swapped",
    inputs: [
      { name: "poolKey", type: "bytes32", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
    ],
  },
] as const;

export const v3FactoryAbi = [
  {
    type: "function", name: "getPool", stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

export const v3PoolAbi = [
  {
    type: "function", name: "slot0", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export const npmAbi = [
  {
    type: "function", name: "positions", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
] as const;

export const v4PositionManagerAbi = [
  {
    type: "function", name: "getPositionLiquidity", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint128" }],
  },
  {
    type: "function", name: "getPoolAndPositionInfo", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { type: "uint256" },
    ],
  },
] as const;

export const v4PoolManagerAbi = [
  {
    type: "function", name: "extsload", stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

export const erc20BalanceAbi = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
