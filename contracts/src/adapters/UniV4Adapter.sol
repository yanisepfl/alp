// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";

import {LiquidityMath} from "../libraries/LiquidityMath.sol";
import {ILiquidityAdapter} from "../interfaces/ILiquidityAdapter.sol";
import {PoolRegistry} from "../PoolRegistry.sol";

/// @notice ALP adapter for Uniswap V4.
///
/// Uniswap V4 differs from V3 in three places this adapter has to bridge:
///   1. Pool identity: V4 pools are not separate contracts. They are keyed by
///      `PoolKey { currency0, currency1, fee, tickSpacing, hooks }` inside the
///      singleton `PoolManager`. We rebuild the `PoolKey` from registry fields.
///   2. Liquidity ops are action-encoded: `PositionManager.modifyLiquidities`
///      consumes a sequence of `Actions` (e.g. MINT_POSITION, SETTLE_PAIR,
///      SWEEP). We assemble those sequences inline.
///   3. Token settlement uses Permit2: the PositionManager pulls tokens via
///      Permit2, while the V4 swap router uses direct `transferFrom`. The
///      adapter lazily sets up each on first use.
///
/// The adapter is otherwise stateless — tokens flow in via `transferFrom` from
/// the vault, leave with `recipient = msg.sender`, and any leftover is swept
/// back to the vault before the call returns.
contract UniV4Adapter is ILiquidityAdapter {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;

    IPositionManager public immutable positionManager;
    IPoolManager public immutable poolManager;
    IUniswapV4Router04 public immutable swapRouter;
    IPermit2 public immutable permit2;
    /// @notice The vault this adapter exclusively serves. Set at construction
    /// and immutable; state-mutating entry points reject other callers.
    address public immutable vault;

    /// @dev token => initialised. Tracks one-time Permit2 setup for the
    /// PositionManager (which pulls tokens via Permit2 inside `modifyLiquidities`).
    mapping(address => bool) internal _permit2Initialised;
    /// @dev token => initialised. Tracks one-time ERC20 approval for the
    /// V4 swap router (which uses direct `transferFrom`, not Permit2).
    mapping(address => bool) internal _routerApproved;

    error UnknownToken(address token);
    error InsufficientLiquidityComputed();
    error NotVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(
        IPositionManager _positionManager,
        IPoolManager _poolManager,
        IUniswapV4Router04 _swapRouter,
        IPermit2 _permit2,
        address _vault
    ) {
        positionManager = _positionManager;
        poolManager = _poolManager;
        swapRouter = _swapRouter;
        permit2 = _permit2;
        vault = _vault;
    }

    // -------- ILiquidityAdapter --------

    function addLiquidity(
        PoolRegistry.Pool calldata pool,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    ) external onlyVault returns (uint256 positionId, uint128 liquidity, uint256 amount0Used, uint256 amount1Used) {
        AddLiquidityVars memory v;
        (v.tickLower, v.tickUpper, v.deadline, v.existingPositionId) =
            abi.decode(extra, (int24, int24, uint256, uint256));

        IERC20(pool.token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        IERC20(pool.token1).safeTransferFrom(msg.sender, address(this), amount1Desired);

        _ensurePermit2(pool.token0);
        _ensurePermit2(pool.token1);

        v.poolKey = _toPoolKey(pool);
        v.bal0Before = IERC20(pool.token0).balanceOf(address(this));
        v.bal1Before = IERC20(pool.token1).balanceOf(address(this));

        liquidity = _quoteLiquidity(v.poolKey, v.tickLower, v.tickUpper, amount0Desired, amount1Desired);
        if (liquidity == 0) revert InsufficientLiquidityComputed();

        if (v.existingPositionId == 0) {
            positionId = positionManager.nextTokenId();
            _mintPosition(v.poolKey, v.tickLower, v.tickUpper, liquidity, amount0Desired, amount1Desired, v.deadline);
        } else {
            positionId = v.existingPositionId;
            _increaseLiquidity(v.poolKey, v.existingPositionId, liquidity, amount0Desired, amount1Desired, v.deadline);
        }

        uint256 bal0After = IERC20(pool.token0).balanceOf(address(this));
        uint256 bal1After = IERC20(pool.token1).balanceOf(address(this));
        amount0Used = v.bal0Before - bal0After;
        amount1Used = v.bal1Before - bal1After;
        if (amount0Used < amount0Min || amount1Used < amount1Min) revert InsufficientLiquidityComputed();
        if (bal0After > 0) IERC20(pool.token0).safeTransfer(msg.sender, bal0After);
        if (bal1After > 0) IERC20(pool.token1).safeTransfer(msg.sender, bal1After);
    }

    function removeLiquidity(
        PoolRegistry.Pool calldata pool,
        uint256 positionId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    ) external onlyVault returns (uint256 amount0Out, uint256 amount1Out, bool burned) {
        (uint256 deadline, bool burnIfEmpty) = abi.decode(extra, (uint256, bool));

        Currency currency0 = Currency.wrap(pool.token0);
        Currency currency1 = Currency.wrap(pool.token1);

        bytes memory actions;
        bytes[] memory params;

        // Match V3 semantics: only burn when the caller signals burnIfEmpty AND
        // the requested removal would empty the position. BURN_POSITION removes
        // all remaining liquidity in one action, so it's the right choice when
        // the caller wants the position closed.
        uint128 currentLiquidity = positionManager.getPositionLiquidity(positionId);
        bool willBeEmpty = currentLiquidity > 0 && liquidity >= currentLiquidity;

        if (burnIfEmpty && willBeEmpty) {
            actions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
            params = new bytes[](2);
            params[0] = abi.encode(positionId, amount0Min, amount1Min, bytes(""));
            params[1] = abi.encode(currency0, currency1, msg.sender);
            burned = true;
        } else {
            actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
            params = new bytes[](2);
            params[0] = abi.encode(positionId, liquidity, amount0Min, amount1Min, bytes(""));
            params[1] = abi.encode(currency0, currency1, msg.sender);
        }

        uint256 bal0Before = IERC20(pool.token0).balanceOf(msg.sender);
        uint256 bal1Before = IERC20(pool.token1).balanceOf(msg.sender);

        positionManager.modifyLiquidities(abi.encode(actions, params), deadline);

        amount0Out = IERC20(pool.token0).balanceOf(msg.sender) - bal0Before;
        amount1Out = IERC20(pool.token1).balanceOf(msg.sender) - bal1Before;
    }

    function collectFees(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        onlyVault
        returns (uint256 amount0, uint256 amount1)
    {
        // V4 collects fees by calling DECREASE_LIQUIDITY with liquidity = 0.
        Currency currency0 = Currency.wrap(pool.token0);
        Currency currency1 = Currency.wrap(pool.token1);

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(positionId, uint128(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(currency0, currency1, msg.sender);

        uint256 bal0Before = IERC20(pool.token0).balanceOf(msg.sender);
        uint256 bal1Before = IERC20(pool.token1).balanceOf(msg.sender);

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        amount0 = IERC20(pool.token0).balanceOf(msg.sender) - bal0Before;
        amount1 = IERC20(pool.token1).balanceOf(msg.sender) - bal1Before;
    }

    function swapExactIn(
        PoolRegistry.Pool calldata pool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata extra
    ) external onlyVault returns (uint256 amountOut) {
        if (tokenIn != pool.token0 && tokenIn != pool.token1) revert UnknownToken(tokenIn);
        bool zeroForOne = (tokenIn == pool.token0);
        address tokenOut = zeroForOne ? pool.token1 : pool.token0;

        // Accept either an explicit `abi.encode(uint256 deadline)` or empty
        // extra (defaults to current block) so callers can pass identical
        // payloads to V3 and V4 adapters without conditional encoding.
        uint256 deadline = extra.length == 0 ? block.timestamp : abi.decode(extra, (uint256));

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        _ensureRouterApproval(tokenIn);

        PoolKey memory key = _toPoolKey(pool);

        uint256 balBefore = IERC20(tokenOut).balanceOf(msg.sender);
        swapRouter.swapExactTokensForTokens(amountIn, amountOutMin, zeroForOne, key, "", msg.sender, deadline);
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balBefore;
    }

    function getPositionAmounts(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        view
        returns (uint256 amount0, uint256 amount1)
    {
        // Burned tokens revert on `getPoolAndPositionInfo`; swallow so callers
        // can iterate a position list that may include stale IDs.
        try positionManager.getPoolAndPositionInfo(positionId) returns (PoolKey memory, PositionInfo info) {
            uint128 liquidity = positionManager.getPositionLiquidity(positionId);
            if (liquidity == 0) return (0, 0);
            uint160 sqrtPriceX96 = _poolSqrtPrice(pool);
            (amount0, amount1) = LiquidityMath.getAmountsForLiquidity(
                sqrtPriceX96,
                TickMath.getSqrtPriceAtTick(info.tickLower()),
                TickMath.getSqrtPriceAtTick(info.tickUpper()),
                liquidity
            );
        } catch {
            return (0, 0);
        }
    }

    function getSpotSqrtPriceX96(PoolRegistry.Pool calldata pool) external view returns (uint160 sqrtPriceX96) {
        sqrtPriceX96 = _poolSqrtPrice(pool);
    }

    function nftManager() external view returns (address) {
        return address(positionManager);
    }

    function getPositionLiquidity(
        PoolRegistry.Pool calldata,
        /* pool */
        uint256 positionId
    )
        external
        view
        returns (uint128 liquidity)
    {
        try positionManager.getPositionLiquidity(positionId) returns (uint128 _liquidity) {
            return _liquidity;
        } catch {
            return 0;
        }
    }

    // -------- internal --------

    struct AddLiquidityVars {
        int24 tickLower;
        int24 tickUpper;
        uint256 deadline;
        uint256 existingPositionId;
        PoolKey poolKey;
        uint256 bal0Before;
        uint256 bal1Before;
    }

    function _toPoolKey(PoolRegistry.Pool calldata pool) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(pool.token0),
            currency1: Currency.wrap(pool.token1),
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            hooks: IHooks(pool.hooks)
        });
    }

    function _poolSqrtPrice(PoolRegistry.Pool calldata pool) internal view returns (uint160 sqrtPriceX96) {
        PoolKey memory key = _toPoolKey(pool);
        PoolId id = key.toId();
        (sqrtPriceX96,,,) = poolManager.getSlot0(id);
    }

    function _quoteLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 amount0, uint256 amount1)
        internal
        view
        returns (uint128 liquidity)
    {
        PoolId id = key.toId();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
    }

    function _mintPosition(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Max,
        uint256 amount1Max,
        uint256 deadline
    ) internal {
        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP), uint8(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, msg.sender, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));
        params[3] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), deadline);
    }

    function _increaseLiquidity(
        PoolKey memory key,
        uint256 positionId,
        uint128 liquidity,
        uint256 amount0Max,
        uint256 amount1Max,
        uint256 deadline
    ) internal {
        bytes memory actions = abi.encodePacked(
            uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP), uint8(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(positionId, liquidity, amount0Max, amount1Max, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));
        params[3] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), deadline);
    }

    /// @dev Permit2 plumbing for the PositionManager (which pulls tokens via
    /// Permit2 inside `modifyLiquidities`). One-shot per token. Sets the
    /// initialised flag before issuing the external approvals so a re-entrant
    /// callback observes the post-state, not a re-runnable pre-state.
    function _ensurePermit2(address token) internal {
        if (_permit2Initialised[token]) return;
        _permit2Initialised[token] = true;
        IERC20(token).forceApprove(address(permit2), type(uint256).max);
        permit2.approve(token, address(positionManager), type(uint160).max, type(uint48).max);
    }

    /// @dev Direct ERC20 approval for the V4 swap router (which uses
    /// `transferFrom`, not Permit2). One-shot per token. Same CEI ordering
    /// as `_ensurePermit2`.
    function _ensureRouterApproval(address token) internal {
        if (_routerApproved[token]) return;
        _routerApproved[token] = true;
        IERC20(token).forceApprove(address(swapRouter), type(uint256).max);
    }
}
