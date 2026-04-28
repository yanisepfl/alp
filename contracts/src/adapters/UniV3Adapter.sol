// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {LiquidityMath} from "../libraries/LiquidityMath.sol";
import {ILiquidityAdapter} from "../interfaces/ILiquidityAdapter.sol";
import {PoolRegistry} from "../PoolRegistry.sol";
import {INonfungiblePositionManager} from "../interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../interfaces/external/ISwapRouter02.sol";
import {IUniswapV3Factory} from "../interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";

/// @notice ALP adapter for Uniswap V3.
///
/// Routes liquidity through `NonfungiblePositionManager` and swaps through
/// `SwapRouter02`. The vault calls every method; the adapter holds no value
/// or NFT between calls.
contract UniV3Adapter is ILiquidityAdapter {
    using SafeERC20 for IERC20;

    INonfungiblePositionManager public immutable npm;
    ISwapRouter02 public immutable swapRouter;
    IUniswapV3Factory public immutable factory;
    /// @notice The vault this adapter exclusively serves. Set at construction
    /// and immutable; state-mutating entry points reject other callers.
    address public immutable vault;

    error UnknownToken(address token);
    error PoolNotFound();
    error NotVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(
        INonfungiblePositionManager _npm,
        ISwapRouter02 _swapRouter,
        IUniswapV3Factory _factory,
        address _vault
    ) {
        npm = _npm;
        swapRouter = _swapRouter;
        factory = _factory;
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
    )
        external
        payable
        onlyVault
        returns (uint256 positionId, uint128 liquidity, uint256 amount0Used, uint256 amount1Used)
    {
        (int24 tickLower, int24 tickUpper, uint256 deadline, uint256 existingPositionId) =
            abi.decode(extra, (int24, int24, uint256, uint256));

        IERC20(pool.token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        IERC20(pool.token1).safeTransferFrom(msg.sender, address(this), amount1Desired);

        // Track balance-before so the refund step works correctly with
        // fee-on-transfer non-base tokens (where `amountUsed` reported by
        // NPM does not match the actual amount removed from this contract).
        uint256 bal0Before = IERC20(pool.token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(pool.token1).balanceOf(address(this));

        IERC20(pool.token0).forceApprove(address(npm), amount0Desired);
        IERC20(pool.token1).forceApprove(address(npm), amount1Desired);

        if (existingPositionId == 0) {
            INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
                token0: pool.token0,
                token1: pool.token1,
                fee: pool.fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: msg.sender,
                deadline: deadline
            });
            (positionId, liquidity, amount0Used, amount1Used) = npm.mint(params);
        } else {
            INonfungiblePositionManager.IncreaseLiquidityParams memory params =
                INonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId: existingPositionId,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    deadline: deadline
                });
            (liquidity, amount0Used, amount1Used) = npm.increaseLiquidity(params);
            positionId = existingPositionId;
        }

        IERC20(pool.token0).forceApprove(address(npm), 0);
        IERC20(pool.token1).forceApprove(address(npm), 0);

        uint256 leftover0 = IERC20(pool.token0).balanceOf(address(this)) - (bal0Before - amount0Desired);
        uint256 leftover1 = IERC20(pool.token1).balanceOf(address(this)) - (bal1Before - amount1Desired);
        if (leftover0 > 0) IERC20(pool.token0).safeTransfer(msg.sender, leftover0);
        if (leftover1 > 0) IERC20(pool.token1).safeTransfer(msg.sender, leftover1);
    }

    function removeLiquidity(
        PoolRegistry.Pool calldata, /* pool */
        uint256 positionId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    ) external onlyVault returns (uint256 amount0Out, uint256 amount1Out, bool burned) {
        (uint256 deadline, bool burnIfEmpty) = abi.decode(extra, (uint256, bool));

        if (liquidity > 0) {
            npm.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: positionId,
                    liquidity: liquidity,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    deadline: deadline
                })
            );
        }

        (amount0Out, amount1Out) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );

        if (burnIfEmpty) {
            (,,,,,,, uint128 remaining,,,,) = npm.positions(positionId);
            if (remaining == 0) {
                npm.burn(positionId);
                burned = true;
            }
        }
    }

    function collectFees(
        PoolRegistry.Pool calldata,
        /* pool */
        uint256 positionId
    )
        external
        onlyVault
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );
    }

    function swapExactIn(
        PoolRegistry.Pool calldata pool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata extra
    ) external payable onlyVault returns (uint256 amountOut) {
        if (tokenIn != pool.token0 && tokenIn != pool.token1) revert UnknownToken(tokenIn);
        address tokenOut = (tokenIn == pool.token0) ? pool.token1 : pool.token0;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: pool.fee,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
        // The V3 SwapRouter02 does not enforce a deadline, but we accept the
        // V4-shaped `abi.encode(uint256 deadline)` payload anyway so the
        // agent can pass identical extra-data through either adapter.
        extra;
    }

    function getPositionAmounts(PoolRegistry.Pool calldata pool, uint256 positionId)
        external
        view
        returns (uint256 amount0, uint256 amount1)
    {
        return _getPositionAmounts(pool, positionId, _poolSqrtPrice(pool));
    }

    function getPositionAmountsAtPrice(PoolRegistry.Pool calldata pool, uint256 positionId, uint160 sqrtPriceX96)
        external
        view
        returns (uint256 amount0, uint256 amount1)
    {
        return _getPositionAmounts(pool, positionId, sqrtPriceX96);
    }

    function _getPositionAmounts(PoolRegistry.Pool calldata, uint256 positionId, uint160 sqrtPriceX96)
        internal
        view
        returns (uint256 amount0, uint256 amount1)
    {
        try npm.positions(positionId) returns (
            uint96,
            address,
            address,
            address,
            uint24,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256,
            uint256,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        ) {
            if (liquidity == 0) {
                return (uint256(tokensOwed0), uint256(tokensOwed1));
            }
            (amount0, amount1) = LiquidityMath.getAmountsForLiquidity(
                sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), liquidity
            );
            amount0 += uint256(tokensOwed0);
            amount1 += uint256(tokensOwed1);
        } catch {
            return (0, 0);
        }
    }

    function poolKeyForPosition(uint256 positionId) external view returns (bytes32) {
        try npm.positions(positionId) returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24 fee,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128,
            uint128
        ) {
            // Match PoolRegistry.poolKey for V3: hooks=0, tickSpacing=0.
            return keccak256(abi.encode(address(this), token0, token1, fee, int24(0), address(0)));
        } catch {
            return bytes32(0);
        }
    }

    function getSpotSqrtPriceX96(PoolRegistry.Pool calldata pool) external view returns (uint160 sqrtPriceX96) {
        sqrtPriceX96 = _poolSqrtPrice(pool);
    }

    function nftManager() external view returns (address) {
        return address(npm);
    }

    /// @notice Helper that returns the canonical V3 tick spacing for a given
    /// fee tier. Useful when constructing a `PoolRegistry.Pool` entry so the
    /// guardian doesn't have to memorise the V3 spec mapping. Reverts on
    /// non-standard fees so misconfigured pools fail loudly at registration
    /// time rather than producing surprising behaviour later.
    function v3TickSpacingForFee(uint24 fee) external pure returns (int24) {
        if (fee == 100) return 1;
        if (fee == 500) return 10;
        if (fee == 3000) return 60;
        if (fee == 10_000) return 200;
        revert("UniV3Adapter: non-standard fee tier");
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
        try npm.positions(positionId) returns (
            uint96,
            address,
            address,
            address,
            uint24,
            int24,
            int24,
            uint128 _liquidity,
            uint256,
            uint256,
            uint128,
            uint128
        ) {
            return _liquidity;
        } catch {
            return 0;
        }
    }

    // -------- internal --------

    function _poolSqrtPrice(PoolRegistry.Pool calldata pool) internal view returns (uint160 sqrtPriceX96) {
        address poolAddr = factory.getPool(pool.token0, pool.token1, pool.fee);
        if (poolAddr == address(0)) revert PoolNotFound();
        (sqrtPriceX96,,,,,,) = IUniswapV3Pool(poolAddr).slot0();
    }
}
