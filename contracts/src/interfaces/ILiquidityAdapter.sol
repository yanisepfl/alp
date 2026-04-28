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
    ) external payable returns (uint256 positionId, uint128 liquidity, uint256 amount0Used, uint256 amount1Used);

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
    ) external payable returns (uint256 amountOut);

    /// @notice Decompose an open position into the underlying token amounts at
    /// the pool's current spot price. Returns 0,0 for burned or unknown
    /// positions so the caller can iterate a list without reverting.
    /// @dev Used by `ALPVault.totalAssets` for trustless on-chain valuation.
    /// Includes any cached `tokensOwed` so the value reflects fees that have
    /// been pushed into the position record by the most recent interaction.
    /// Live fees that have not been pushed yet are not reflected — the vault
    /// flushes those by calling `collectFees` before each user interaction.
    function getPositionAmounts(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        view
        returns (uint256 amount0, uint256 amount1);

    /// @notice Same as `getPositionAmounts` but lets the caller supply the
    /// pool's current `sqrtPriceX96` so the adapter doesn't have to fetch
    /// it again. Used by `ALPVault.totalAssets()` to amortise the slot0
    /// read across every position in a pool.
    function getPositionAmountsAtPrice(PoolRegistry.Pool calldata pool, uint256 positionId, uint160 sqrtPriceX96)
        external
        view
        returns (uint256 amount0, uint256 amount1);

    /// @notice Returns the PoolKey hash that the adapter would compute for a
    /// given position. Vault uses this to bind a position id to a registry
    /// pool key when tracking — preventing a malicious or buggy agent from
    /// routing one pool's position through another pool's accounting slot.
    /// Returns `bytes32(0)` for unknown / burned positions.
    function poolKeyForPosition(uint256 positionId) external view returns (bytes32);

    /// @notice Returns the pool's current spot price as a Q64.96 sqrt(token1/token0).
    /// Used by the vault to value non-base tokens in base-asset units.
    function getSpotSqrtPriceX96(PoolRegistry.Pool calldata pool) external view returns (uint160 sqrtPriceX96);

    /// @notice Returns the current liquidity of a position. Returns 0 for
    /// burned or unknown positions so callers can iterate a list without
    /// reverting.
    function getPositionLiquidity(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        view
        returns (uint128 liquidity);

    /// @notice Address of the ERC721 contract that issues this adapter's LP
    /// position NFTs (the V3 NonfungiblePositionManager or the V4
    /// PositionManager). The vault uses this in `bootstrapAdapter` to make
    /// sure the operator approval lands on the right ERC721.
    function nftManager() external view returns (address);
}
