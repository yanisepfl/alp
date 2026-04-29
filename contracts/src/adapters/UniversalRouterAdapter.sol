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

    /// @notice WETH on Base. URAdapter pools that route native ETH still need
    /// a V3 spot pool for the per-tx notional cap valuation; we substitute
    /// WETH for `address(0)` when querying the V3 factory. Same predeploy on
    /// Base mainnet and Base Sepolia.
    address public constant WRAPPED_NATIVE = 0x4200000000000000000000000000000000000006;

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
    error UnexpectedEth();
    error UnexpectedAdapterBalance();

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
    ) external payable onlyVault returns (uint256 amountOut) {
        if (tokenIn != pool.token0 && tokenIn != pool.token1) revert UnknownToken(tokenIn);
        address tokenOut = tokenIn == pool.token0 ? pool.token1 : pool.token0;

        // Belt-and-suspenders against slippage-bypass-via-donation: the
        // adapter holds nothing between calls, so any pre-call balance of
        // tokenIn or tokenOut is either an attacker-planted donation or a
        // bug. Either way, refusing to swap when the adapter is "dirty"
        // closes the loophole where attacker pre-sends tokenOut to inflate
        // the post-swap balance delta and silently bypass amountOutMin.
        if (_balanceOfHolder(tokenIn, address(this)) != 0) revert UnexpectedAdapterBalance();
        if (_balanceOfHolder(tokenOut, address(this)) != 0) revert UnexpectedAdapterBalance();

        (bytes memory commands, bytes[] memory inputs, uint256 deadline) = abi.decode(extra, (bytes, bytes[], uint256));

        // Pull input. Native ETH (token == address(0)) arrives as msg.value
        // and gets forwarded to UR; ERC20s use the Permit2 flow.
        if (tokenIn == address(0)) {
            require(msg.value == amountIn, "ETH value mismatch");
        } else {
            if (msg.value != 0) revert UnexpectedEth();
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            // Permit2 approval flow: one-shot infinite ERC20 approval to Permit2,
            // then a per-call exact-amount Permit2 grant to the Universal Router.
            // Setting the per-call grant to exactly `amountIn` with `expiration =
            // deadline` keeps the surface tight: any leftover allowance after
            // this call expires with `deadline`.
            _ensurePermit2(tokenIn);
            permit2.approve(tokenIn, address(router), uint160(amountIn), uint48(deadline));
        }

        uint256 vaultOutBefore = _balanceOfHolder(tokenOut, msg.sender);

        router.execute{value: tokenIn == address(0) ? amountIn : 0}(commands, inputs, deadline);

        // Sweep any tokens left on the adapter back to the vault. UR may
        // deliver output to the adapter (if commands set recipient = adapter)
        // or leave unused input behind on a partial fill. Either way the
        // vault should receive everything.
        _sweep(tokenOut, msg.sender);
        _sweep(tokenIn, msg.sender);

        uint256 vaultOutAfter = _balanceOfHolder(tokenOut, msg.sender);
        amountOut = vaultOutAfter - vaultOutBefore;

        if (amountOut < amountOutMin) revert InsufficientOutput(amountOutMin, amountOut);
    }

    /// @notice Receive native ETH from Universal Router (when tokenOut is
    /// native or routes that use UNWRAP_WETH end up here). Forwarded to the
    /// vault by `_sweep` at the end of `swapExactIn`.
    receive() external payable {}

    /// @notice Permissionless escape hatch for dust donations. The dirty-balance
    /// check in `swapExactIn` would otherwise turn any 1-wei donation (ERC20
    /// transfer or `selfdestruct` ETH) into a permanent DoS for that token.
    /// Anyone can call this to flush stuck balance to the vault — funds always
    /// go to `vault`, so the function is safe to leave open and removes the
    /// donor's economic motivation entirely.
    function sweep(address token) external {
        _sweep(token, vault);
    }

    // -------- ILiquidityAdapter (liquidity path is unsupported) --------

    function addLiquidity(PoolRegistry.Pool calldata, uint256, uint256, uint256, uint256, bytes calldata)
        external
        payable
        returns (uint256, uint128, uint256, uint256)
    {
        // Function reverts unconditionally; msg.value (if any) bubbles back
        // with the revert and the caller's balance is unchanged.
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

    /// @notice URAdapter is swap-only and the vault's auto-unwind never goes
    /// through it (unwind drains positions registered via V3/V4 adapters).
    /// Returns 0 so the interface contract holds without dragging in V3
    /// observe wiring here.
    function getTwapSqrtPriceX96(PoolRegistry.Pool calldata, uint32) external pure returns (uint160) {
        return 0;
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
        // V3 factory only knows ERC20 tokens; substitute WRAPPED_NATIVE for
        // address(0) so we can still resolve a spot pool for native-ETH UR
        // entries (the V4 native pool's WETH twin lives at the V3 0.05% tier).
        address t0 = pool.token0 == address(0) ? WRAPPED_NATIVE : pool.token0;
        address t1 = pool.token1 == address(0) ? WRAPPED_NATIVE : pool.token1;
        address poolAddr = factory.getPool(t0, t1, pool.fee);
        if (poolAddr == address(0)) revert PoolNotFound();
        (sqrtPriceX96,,,,,,) = IUniswapV3Pool(poolAddr).slot0();
    }

    function _balanceOfHolder(address token, address holder) internal view returns (uint256) {
        return token == address(0) ? holder.balance : IERC20(token).balanceOf(holder);
    }

    function _sweep(address token, address to) internal {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok,) = to.call{value: bal}("");
                require(ok, "ETH sweep failed");
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }
}
