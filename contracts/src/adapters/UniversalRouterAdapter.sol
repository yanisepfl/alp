// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

import {ILiquidityAdapter} from "../interfaces/ILiquidityAdapter.sol";
import {PoolRegistry} from "../PoolRegistry.sol";
import {IUniswapV3Factory} from "../interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";
import {IUniversalRouter} from "../interfaces/external/IUniversalRouter.sol";

/// @notice Swap-only ALP adapter that forwards calls to Uniswap's Universal
/// Router. Lets the off-chain agent execute multi-hop / split-route swaps
/// returned by the Uniswap Trading API while keeping the vault's accounting,
/// `onlyAgent` gating and per-tx notional cap intact.
///
/// Liquidity-management methods revert: this adapter only handles swaps. LP
/// positions are still routed through `UniV3Adapter` / `UniV4Adapter`.
///
/// Security model: the adapter does not parse the Universal Router commands.
/// Instead it asserts a balance delta on the vault — `vault.tokenOut` must
/// grow by at least `amountOutMin`. If the agent submits malformed commands
/// that route output to the wrong recipient, the assertion reverts. The
/// `tickSpacing > 0` and `hooks == address(0)` registry checks remain in
/// force at registration time.
///
/// `getSpotSqrtPriceX96` reads from the configured V3 pool (the same pair
/// the registry entry points at) so the vault's per-tx notional cap can
/// price `amountIn` in base-asset units.
contract UniversalRouterAdapter is ILiquidityAdapter {
    using SafeERC20 for IERC20;

    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    IUniswapV3Factory public immutable factory;
    /// @notice The vault this adapter exclusively serves. Set at construction
    /// and immutable; state-mutating entry points reject other callers.
    address public immutable vault;

    /// @dev token => initialised. Tracks the one-time `IERC20.approve(permit2, max)`
    /// step. The per-tx Permit2 grant to the router is set fresh in every swap
    /// (with the exact `amountIn`) so a stale allowance can never be reused.
    mapping(address => bool) internal _permit2Initialised;

    error NotSupported();
    error NotVault();
    error UnknownToken(address token);
    error InsufficientOutput(uint256 minOut, uint256 actualOut);
    error PoolNotFound();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(IUniversalRouter _router, IPermit2 _permit2, IUniswapV3Factory _factory, address _vault) {
        router = _router;
        permit2 = _permit2;
        factory = _factory;
        vault = _vault;
    }

    // -------- ILiquidityAdapter (swap path) --------

    /// @notice Forward a Universal Router swap. `extra` carries the API-built
    /// payload `abi.encode(bytes commands, bytes[] inputs, uint256 deadline)`.
    /// The output is asserted by balance-delta on the vault, not by parsing
    /// the commands.
    function swapExactIn(
        PoolRegistry.Pool calldata pool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata extra
    ) external onlyVault returns (uint256 amountOut) {
        if (tokenIn != pool.token0 && tokenIn != pool.token1) revert UnknownToken(tokenIn);
        address tokenOut = tokenIn == pool.token0 ? pool.token1 : pool.token0;

        (bytes memory commands, bytes[] memory inputs, uint256 deadline) = abi.decode(extra, (bytes, bytes[], uint256));

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Permit2 approval flow: one-shot infinite ERC20 approval to Permit2,
        // then a per-call exact-amount Permit2 grant to the Universal Router.
        // Setting the per-call grant to exactly `amountIn` with `expiration =
        // deadline` keeps the surface tight: any leftover allowance after
        // this call expires with `deadline`.
        _ensurePermit2(tokenIn);
        permit2.approve(tokenIn, address(router), uint160(amountIn), uint48(deadline));

        uint256 vaultOutBefore = IERC20(tokenOut).balanceOf(msg.sender);

        router.execute(commands, inputs, deadline);

        // Sweep any tokens left on the adapter back to the vault. UR may
        // deliver output to the adapter (if commands set recipient = adapter)
        // or leave unused input behind on a partial fill. Either way the
        // vault should receive everything.
        uint256 adapterOutBal = IERC20(tokenOut).balanceOf(address(this));
        if (adapterOutBal > 0) IERC20(tokenOut).safeTransfer(msg.sender, adapterOutBal);
        uint256 adapterInBal = IERC20(tokenIn).balanceOf(address(this));
        if (adapterInBal > 0) IERC20(tokenIn).safeTransfer(msg.sender, adapterInBal);

        uint256 vaultOutAfter = IERC20(tokenOut).balanceOf(msg.sender);
        amountOut = vaultOutAfter - vaultOutBefore;

        if (amountOut < amountOutMin) revert InsufficientOutput(amountOutMin, amountOut);
    }

    // -------- ILiquidityAdapter (liquidity path is unsupported) --------

    function addLiquidity(PoolRegistry.Pool calldata, uint256, uint256, uint256, uint256, bytes calldata)
        external
        pure
        returns (uint256, uint128, uint256, uint256)
    {
        revert NotSupported();
    }

    function removeLiquidity(PoolRegistry.Pool calldata, uint256, uint128, uint256, uint256, bytes calldata)
        external
        pure
        returns (uint256, uint256, bool)
    {
        revert NotSupported();
    }

    function collectFees(PoolRegistry.Pool calldata, uint256) external pure returns (uint256, uint256) {
        revert NotSupported();
    }

    // -------- ILiquidityAdapter (views) --------

    /// @notice Spot price for the configured V3 pool referenced by the
    /// registry entry. Used by the vault to value `amountIn` in base-asset
    /// units when enforcing the per-tx notional cap.
    function getSpotSqrtPriceX96(PoolRegistry.Pool calldata pool) external view returns (uint160 sqrtPriceX96) {
        sqrtPriceX96 = _poolSqrtPrice(pool);
    }

    /// @notice URAdapter never holds positions; always returns zero so the
    /// vault's `totalAssets` loop can iterate without reverting.
    function getPositionAmounts(PoolRegistry.Pool calldata, uint256) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    function getPositionAmountsAtPrice(PoolRegistry.Pool calldata, uint256, uint160)
        external
        pure
        returns (uint256, uint256)
    {
        return (0, 0);
    }

    function getPositionLiquidity(PoolRegistry.Pool calldata, uint256) external pure returns (uint128) {
        return 0;
    }

    function poolKeyForPosition(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }

    /// @notice URAdapter does not custody LP NFTs; returns the zero address so
    /// `bootstrapAdapter` calls that try to grant operator status to it fail
    /// loudly rather than silently misconfiguring.
    function nftManager() external pure returns (address) {
        return address(0);
    }

    // -------- internal --------

    function _ensurePermit2(address token) internal {
        if (_permit2Initialised[token]) return;
        _permit2Initialised[token] = true;
        IERC20(token).forceApprove(address(permit2), type(uint256).max);
    }

    function _poolSqrtPrice(PoolRegistry.Pool calldata pool) internal view returns (uint160 sqrtPriceX96) {
        address poolAddr = factory.getPool(pool.token0, pool.token1, pool.fee);
        if (poolAddr == address(0)) revert PoolNotFound();
        (sqrtPriceX96,,,,,,) = IUniswapV3Pool(poolAddr).slot0();
    }
}
