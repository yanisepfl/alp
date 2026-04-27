// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {LiquidityMath} from "../../src/libraries/LiquidityMath.sol";

contract LiquidityMathTest is Test {
    int24 internal constant TICK_LOWER = -6_000;
    int24 internal constant TICK_UPPER = 6_000;

    /// @dev Spot price below the range — liquidity is fully token0.
    function test_getAmountsForLiquidity_belowRange_isAllToken0() public pure {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint160 sqrtSpot = TickMath.getSqrtPriceAtTick(TICK_LOWER - 100);

        (uint256 amount0, uint256 amount1) = LiquidityMath.getAmountsForLiquidity(sqrtSpot, sqrtA, sqrtB, 1e18);
        assertGt(amount0, 0);
        assertEq(amount1, 0);
    }

    /// @dev Spot price within range — yields both sides.
    function test_getAmountsForLiquidity_inRange_isMixed() public pure {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint160 sqrtSpot = TickMath.getSqrtPriceAtTick(0);

        (uint256 amount0, uint256 amount1) = LiquidityMath.getAmountsForLiquidity(sqrtSpot, sqrtA, sqrtB, 1e18);
        assertGt(amount0, 0);
        assertGt(amount1, 0);
    }

    /// @dev Spot price above the range — liquidity is fully token1.
    function test_getAmountsForLiquidity_aboveRange_isAllToken1() public pure {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint160 sqrtSpot = TickMath.getSqrtPriceAtTick(TICK_UPPER + 100);

        (uint256 amount0, uint256 amount1) = LiquidityMath.getAmountsForLiquidity(sqrtSpot, sqrtA, sqrtB, 1e18);
        assertEq(amount0, 0);
        assertGt(amount1, 0);
    }

    /// @dev Boundary swap: callers passing tick boundaries unsorted should
    /// still produce the correct numbers (the library normalises them).
    function test_getAmountsForLiquidity_unsortedBoundaries_isStable() public pure {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint160 sqrtSpot = TickMath.getSqrtPriceAtTick(0);

        (uint256 a0, uint256 a1) = LiquidityMath.getAmountsForLiquidity(sqrtSpot, sqrtA, sqrtB, 1e18);
        (uint256 b0, uint256 b1) = LiquidityMath.getAmountsForLiquidity(sqrtSpot, sqrtB, sqrtA, 1e18);
        assertEq(a0, b0);
        assertEq(a1, b1);
    }

    function test_getAmount0ForLiquidity_unsortedBoundaries_isStable() public pure {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 a = LiquidityMath.getAmount0ForLiquidity(sqrtA, sqrtB, 1e18);
        uint256 b = LiquidityMath.getAmount0ForLiquidity(sqrtB, sqrtA, 1e18);
        assertEq(a, b);
    }

    function test_getAmount1ForLiquidity_unsortedBoundaries_isStable() public pure {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 a = LiquidityMath.getAmount1ForLiquidity(sqrtA, sqrtB, 1e18);
        uint256 b = LiquidityMath.getAmount1ForLiquidity(sqrtB, sqrtA, 1e18);
        assertEq(a, b);
    }
}
