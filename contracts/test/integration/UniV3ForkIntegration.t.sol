// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {ALPVault} from "../../src/ALPVault.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {UniV3Adapter} from "../../src/adapters/UniV3Adapter.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../../src/interfaces/external/ISwapRouter02.sol";
import {IUniswapV3Factory} from "../../src/interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../../src/interfaces/external/IUniswapV3Pool.sol";

/// @notice Fork test against Base mainnet that exercises the V3 path against
/// real Uniswap V3 contracts and the canonical USDC/WETH 0.05% pool.
///
/// To run:
///   BASE_RPC_URL=<rpc> forge test --match-path test/integration/UniV3ForkIntegration.t.sol
///
/// Without `BASE_RPC_URL` set, every test in the suite is skipped via `vm.skip`.
/// This keeps CI green when the env var is unavailable while preserving the
/// authoritative integration check for whoever has an RPC.
contract UniV3ForkIntegrationTest is Test {
    // Canonical Base mainnet addresses
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant V3_NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address internal constant V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    uint24 internal constant FEE = 500; // 0.05% USDC/WETH pool

    PoolRegistry internal registry;
    UniV3Adapter internal adapter;
    ALPVault internal vault;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");

    address internal token0;
    address internal token1;
    bytes32 internal poolKeyHash;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        // sort tokens
        token0 = USDC < WETH ? USDC : WETH;
        token1 = USDC < WETH ? WETH : USDC;

        registry = new PoolRegistry(owner, guardian);
        vault = new ALPVault(IERC20(USDC), "ALP USDC Vault", "alpUSDC", registry, owner, address(this), guardian);
        adapter = new UniV3Adapter(
            INonfungiblePositionManager(V3_NPM),
            ISwapRouter02(V3_SWAP_ROUTER),
            IUniswapV3Factory(V3_FACTORY),
            address(vault)
        );

        PoolRegistry.Pool memory pool = PoolRegistry.Pool({
            adapter: address(adapter),
            token0: token0,
            token1: token1,
            fee: FEE,
            tickSpacing: 10, // V3 USDC/WETH 0.05% — informational
            hooks: address(0),
            maxAllocationBps: 10_000,
            enabled: true
        });
        vm.prank(guardian);
        poolKeyHash = registry.addPool(pool);

        vm.prank(guardian);
        vault.bootstrapAdapter(V3_NPM, address(adapter));

        // Pre-fund alice and the vault for the test scenarios.
        deal(USDC, alice, 100_000e6);
        vm.prank(alice);
        IERC20(USDC).approve(address(vault), type(uint256).max);
    }

    // -------- positive flows --------

    function test_addLiquidity_v3_mintsPositionToVault() public {
        vm.prank(alice);
        vault.deposit(10_000e6, alice);

        // Provide WETH side directly so we don't have to swap first in this isolated test.
        deal(WETH, address(vault), 5e18);

        uint256 nextId = INonfungiblePositionManager(V3_NPM).positions.selector == bytes4(0) ? 0 : 0; // placeholder
        nextId; // silence unused warning

        // Use a wide tick range on the V3 USDC/WETH pool. Ticks must be multiples of
        // tickSpacing (10 for the 0.05% fee tier).
        (uint256 positionId, uint128 liquidity, uint256 used0, uint256 used1) = vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? 5_000e6 : 2e18,
            token0 == USDC ? 2e18 : 5_000e6,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );

        assertGt(positionId, 0);
        assertGt(liquidity, 0);
        assertGt(used0, 0);
        assertGt(used1, 0);
        assertEq(IERC721(V3_NPM).ownerOf(positionId), address(vault));
    }

    function test_swap_v3_movesTokens() public {
        deal(USDC, address(vault), 1_000e6);

        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));

        uint256 amountOut = vault.executeSwap(poolKeyHash, USDC, 100e6, 1, abi.encode(block.timestamp + 600));

        assertGt(amountOut, 0);
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultUsdcBefore - 100e6);
        assertEq(IERC20(WETH).balanceOf(address(vault)), vaultWethBefore + amountOut);
    }

    function test_v3_collectFees_growsBookTAV() public {
        vm.prank(alice);
        vault.deposit(20_000e6, alice);
        vault.executeSwap(poolKeyHash, USDC, 5_000e6, 1, abi.encode(block.timestamp + 600));

        uint256 vaultUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWeth = IERC20(WETH).balanceOf(address(vault));
        (uint256 positionId,,,) = vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? vaultUsdc : vaultWeth,
            token0 == USDC ? vaultWeth : vaultUsdc,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );

        // Try to collect — fees may be near-zero on a fresh position but the
        // call path itself should run cleanly and not break bookTAV.
        uint256 bookBefore = vault.bookTAV();
        vault.executeCollectFees(poolKeyHash, positionId);
        uint256 bookAfter = vault.bookTAV();
        assertGe(bookAfter, bookBefore, "bookTAV should be monotonic on collect");
    }

    function test_v3_increaseLiquidity_onExistingPosition() public {
        vm.prank(alice);
        vault.deposit(20_000e6, alice);
        vault.executeSwap(poolKeyHash, USDC, 10_000e6, 1, abi.encode(block.timestamp + 600));

        uint256 vaultUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWeth = IERC20(WETH).balanceOf(address(vault));
        // Mint a small position first using only part of the balance.
        (uint256 positionId, uint128 liquidityBefore,,) = vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? vaultUsdc / 2 : vaultWeth / 2,
            token0 == USDC ? vaultWeth / 2 : vaultUsdc / 2,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );

        // Now increase by routing the rest into the SAME position via existingPositionId.
        uint256 vaultUsdcNow = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWethNow = IERC20(WETH).balanceOf(address(vault));
        (uint256 sameId, uint128 added,,) = vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? vaultUsdcNow : vaultWethNow,
            token0 == USDC ? vaultWethNow : vaultUsdcNow,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, positionId)
        );
        assertEq(sameId, positionId);
        assertGt(added, 0);
        uint128 liquidityAfter = adapter.getPositionLiquidity(
            PoolRegistry.Pool(address(0), address(0), address(0), address(0), 0, 0, 0, false), positionId
        );
        // Just confirm liquidity moved in the right direction; the exact value
        // depends on the live spot at fork time.
        assertGt(liquidityAfter, liquidityBefore);
    }

    function test_lifecycle_v3_fullCycle() public {
        // 1. Deposit
        vm.prank(alice);
        vault.deposit(20_000e6, alice);

        // 2. Swap half to WETH
        uint256 wethReceived = vault.executeSwap(poolKeyHash, USDC, 10_000e6, 1, abi.encode(block.timestamp + 600));
        assertGt(wethReceived, 0);

        // 3. Add liquidity full-range
        uint256 vaultUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWeth = IERC20(WETH).balanceOf(address(vault));
        (uint256 positionId, uint128 liquidity,,) = vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? vaultUsdc : vaultWeth,
            token0 == USDC ? vaultWeth : vaultUsdc,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );
        assertEq(IERC721(V3_NPM).ownerOf(positionId), address(vault));

        // 4. Remove all liquidity (also collects)
        vault.executeRemoveLiquidity(poolKeyHash, positionId, liquidity, 0, 0, abi.encode(block.timestamp + 600, true));

        // 5. Swap WETH back to USDC for clean withdraw accounting
        uint256 wethLeft = IERC20(WETH).balanceOf(address(vault));
        if (wethLeft > 0) {
            vault.executeSwap(poolKeyHash, WETH, wethLeft, 1, abi.encode(block.timestamp + 600));
        }

        // 6. Alice withdraws — should retrieve > 99% (round-trip swap fees ~0.1% twice)
        uint256 aliceBefore = IERC20(USDC).balanceOf(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        // Same-block-mint-and-redeem lockout: advance the block before alice exits.
        vm.roll(block.number + 1);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 received = IERC20(USDC).balanceOf(alice) - aliceBefore;
        assertGe(received, (20_000e6 * 990) / 1000, "alice lost too much on round trip");
    }

    // -------- Auto-unwind under price drift --------

    /// Build a vault state where idle USDC is too small to satisfy a
    /// 15k withdraw, forcing `_withdraw` into the unwind path. We do this
    /// by depositing 50k, swapping 30k to WETH, then putting most of the
    /// 50/50 split into a wide-range LP. Returns once the position is open
    /// and the same-block lockout has been rolled past.
    function _setUpUnwindScenario() internal {
        vm.prank(alice);
        vault.deposit(50_000e6, alice);
        vault.executeSwap(poolKeyHash, USDC, 30_000e6, 1, abi.encode(block.timestamp + 600));
        uint256 vUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 vWeth = IERC20(WETH).balanceOf(address(vault));
        vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? vUsdc : vWeth,
            token0 == USDC ? vWeth : vUsdc,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );
        vm.roll(block.number + 1);
    }

    /// Route a swap directly through Uniswap's V3 router (NOT via the vault)
    /// so the pool's spot moves but the vault's positions are untouched.
    /// Used to simulate either natural drift or a sandwich attacker.
    function _movePoolWeth(uint256 wethIn) internal {
        address ext = makeAddr("ext-mover");
        deal(WETH, ext, wethIn);
        vm.startPrank(ext);
        IERC20(WETH).approve(V3_SWAP_ROUTER, type(uint256).max);
        ISwapRouter02(V3_SWAP_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: USDC,
                fee: FEE,
                recipient: ext,
                amountIn: wethIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    /// Natural drift: a small WETH→USDC swap moves spot ~tens of bps. The
    /// 5-min TWAP, which still mostly reflects pre-swap pool state, lags
    /// only slightly. Spot/TWAP gap stays well below the 100bps sqrt-price
    /// guard, so the unwind swap proceeds and the user's withdraw succeeds.
    function test_unwind_naturalDrift_withdrawSucceeds() public {
        _setUpUnwindScenario();

        // Snapshot the pool's spot tick so we can confirm a real move
        // happened and we can measure post-move drift if it ever changes.
        address poolAddr = IUniswapV3Factory(V3_FACTORY).getPool(token0, token1, FEE);
        (, int24 tickBefore,,,,,) = IUniswapV3Pool(poolAddr).slot0();

        // Real swap: 5 WETH ≈ a meaningful chunk but well within the pool's
        // depth. Should nudge spot by tens of bps, not hundreds.
        _movePoolWeth(5e18);

        (, int24 tickAfter,,,,,) = IUniswapV3Pool(poolAddr).slot0();
        assertTrue(tickBefore != tickAfter, "spot did not actually move");

        // Warp 60s — enough for the TWAP read to include both windows.
        vm.warp(block.timestamp + 60);

        // The withdraw will need ~all of the position liquidity since idle
        // USDC is small. The unwind path runs; the deviation guard should
        // see the modest spot move and allow the swap.
        uint256 aliceBefore = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        uint256 sharesBurned = vault.withdraw(15_000e6, alice, alice);

        assertGt(sharesBurned, 0, "no shares burned");
        assertEq(IERC20(USDC).balanceOf(alice) - aliceBefore, 15_000e6, "alice did not receive requested amount");
    }

    /// Sandwich-class manipulation: a much bigger WETH→USDC swap pushes
    /// spot far enough away from the 5-min TWAP that the deviation guard
    /// trips. The unwind swap is silently skipped, the vault doesn't free
    /// enough USDC to cover the requested amount, and ERC4626's
    /// `super._withdraw` reverts on the underlying ERC20 transfer.
    function test_unwind_sandwichDetected_withdrawReverts() public {
        _setUpUnwindScenario();

        // Drain almost all idle USDC so the vault can't satisfy ANY part of
        // the withdraw without unwinding the position. Sending elsewhere
        // (not back to vault) so it stays gone.
        uint256 idle = IERC20(USDC).balanceOf(address(vault));
        if (idle > 100e6) {
            // Use stdstore-equivalent via deal: zero the vault's USDC, give
            // the diff to a sink. We use deal to set vault's balance.
            deal(USDC, address(vault), 100e6);
        }

        // Big swap: ~500 WETH on a 0.05% pool will move spot enough to
        // trigger the deviation guard against the just-snapshotted TWAP.
        // (Smaller than initially planned because public RPCs throttle on
        // huge cross-tick swaps that require loading lots of tick data.)
        _movePoolWeth(500e18);

        // No warp — the gap is maximal right after the manipulation.

        // Withdraw should revert: unwind path skips the manipulated pool's
        // swap (deviation guard), vault still doesn't hold enough idle USDC,
        // super._withdraw reverts on the ERC20 transfer.
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(15_000e6, alice, alice);

        // Sanity: redeemInKind still works — that path doesn't go through
        // the auto-unwind swap, so the user has an escape hatch even when
        // the deviation guard locks the swap out.
        uint256 aliceShares = vault.balanceOf(alice);
        address[] memory expected = new address[](0);
        uint256[] memory mins = new uint256[](0);
        vm.prank(alice);
        vault.redeemInKind(aliceShares / 4, alice, alice, expected, mins);
    }

    /// Multi-user scenario with real price drift between actions. Alice
    /// deposits, the pool drifts via real swaps, Bob deposits, the pool
    /// drifts again, then Alice exits. Confirms (a) Bob's deposit is priced
    /// against the post-drift state (so he doesn't get free shares), and
    /// (b) Alice doesn't lose value beyond what realised IL/swap fees would
    /// cause.
    function test_multiUser_naturalDrift_sharePricingHolds() public {
        // Alice enters first
        vm.prank(alice);
        vault.deposit(20_000e6, alice);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 sharePriceAfterAlice = vault.totalAssets() * 1e18 / vault.totalSupply();

        // Build a position so subsequent drift actually affects marketTAV.
        vault.executeSwap(poolKeyHash, USDC, 10_000e6, 1, abi.encode(block.timestamp + 600));
        uint256 vUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 vWeth = IERC20(WETH).balanceOf(address(vault));
        vault.executeAddLiquidity(
            poolKeyHash,
            token0 == USDC ? vUsdc : vWeth,
            token0 == USDC ? vWeth : vUsdc,
            0,
            0,
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );

        vm.roll(block.number + 1);

        // Drift episode 1: small swap, then warp
        _movePoolWeth(2e18);
        vm.warp(block.timestamp + 30);

        // Bob enters at the post-drift state. With MAX(book, market) for the
        // deposit rail he prices against whichever side moved; either way
        // his shares should reflect the current per-share value.
        address bob = makeAddr("bob");
        deal(USDC, bob, 50_000e6);
        vm.prank(bob);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        uint256 sharePriceAtBobEntry = vault.totalAssets() * 1e18 / vault.totalSupply();
        vm.prank(bob);
        vault.deposit(20_000e6, bob);
        uint256 bobShares = vault.balanceOf(bob);

        // Bob should NOT receive more shares than alice did at the pre-drift
        // share price — the MAX rail clamps him to the higher of book/market.
        assertLe(
            bobShares * sharePriceAtBobEntry / 1e18,
            (20_000e6 * sharePriceAtBobEntry / sharePriceAfterAlice) + 1,
            "bob received free shares"
        );

        // Drift episode 2 (opposite direction)
        address ext = makeAddr("ext-roundtrip");
        deal(USDC, ext, 20_000e6);
        vm.startPrank(ext);
        IERC20(USDC).approve(V3_SWAP_ROUTER, type(uint256).max);
        ISwapRouter02(V3_SWAP_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: FEE,
                recipient: ext,
                amountIn: 5_000e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        vm.warp(block.timestamp + 60);

        // Alice exits. Should retrieve close to her original deposit minus
        // round-trip swap fees and any realised IL — but well above 95%.
        uint256 aliceBefore = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 received = IERC20(USDC).balanceOf(alice) - aliceBefore;

        assertGe(received, (20_000e6 * 950) / 1000, "alice round-trip too lossy");
    }
}
