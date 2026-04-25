// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolRegistry} from "../PoolRegistry.sol";

/// @notice Uniform interface implemented by every Uniswap-version adapter.
///
/// The vault holds all assets. For each call it grants the adapter a transient
/// ERC20 approval, then invokes the adapter. The adapter pulls tokens from
/// `msg.sender`, calls the underlying Uniswap contracts with `recipient =
/// msg.sender`, and refunds any leftover before returning. Adapters never
/// custody assets between calls.
///
/// LP-NFT operations (`removeLiquidity`, `collectFees`) require the caller to
/// have set the adapter as `setApprovalForAll(adapter, true)` on the underlying
/// PositionManager (V3 NonfungiblePositionManager or V4 PositionManager). The
/// vault performs that one-time setup via `bootstrapAdapter`.
interface ILiquidityAdapter {
    /// @notice Mint a new position (when `existingPositionId == 0`) or top up
    /// an existing one. The position is owned by `msg.sender`.
    /// @param extra abi.encode(int24 tickLower, int24 tickUpper, uint256 deadline, uint256 existingPositionId)
    function addLiquidity(
        PoolRegistry.Pool calldata pool,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    ) external returns (uint256 positionId, uint128 liquidity, uint256 amount0Used, uint256 amount1Used);

    /// @notice Remove `liquidity` from `positionId` and forward the released
    /// tokens (and any owed fees) to `msg.sender`.
    /// @param extra abi.encode(uint256 deadline, bool burnIfEmpty)
    /// @return amount0Out token0 sent to the caller
    /// @return amount1Out token1 sent to the caller
    /// @return burned true if the position NFT was burned during this call
    function removeLiquidity(
        PoolRegistry.Pool calldata pool,
        uint256 positionId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    ) external returns (uint256 amount0Out, uint256 amount1Out, bool burned);

    /// @notice Collect accrued LP fees for `positionId` to `msg.sender`.
    function collectFees(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        returns (uint256 amount0, uint256 amount1);

    /// @notice Single-pool exact-input swap. `tokenIn` must be one of the
    /// pool's tokens; output goes to `msg.sender`.
    /// @param extra abi.encode(uint256 deadline) for adapters that require it
    function swapExactIn(
        PoolRegistry.Pool calldata pool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata extra
    ) external returns (uint256 amountOut);

    /// @notice Decompose an open position into the underlying token amounts at
    /// the pool's current spot price. Returns 0,0 for burned or unknown
    /// positions so the caller can iterate a list without reverting.
    /// @dev Used by `ALPVault.totalAssets` for trustless on-chain valuation.
    /// Only the principal is reported; uncollected swap fees are intentionally
    /// excluded so valuation is conservative under fee accrual.
    function getPositionAmounts(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        view
        returns (uint256 amount0, uint256 amount1);

    /// @notice Returns the pool's current spot price as a Q64.96 sqrt(token1/token0).
    /// Used by the vault to value non-base tokens in base-asset units.
    function getSpotSqrtPriceX96(PoolRegistry.Pool calldata pool) external view returns (uint160 sqrtPriceX96);
}
