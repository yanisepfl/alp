// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {V4Deployers} from "../utils/V4Deployers.sol";
import {ALPVault} from "../../src/ALPVault.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {UniV4Adapter} from "../../src/adapters/UniV4Adapter.sol";
import {MockERC20Token} from "../mocks/MockERC20Token.sol";

/// @notice Lifecycle scenarios that don't fit cleanly in the happy-path
/// integration suite: soft-disabling a pool, removing it from the registry
/// while positions are still open, base-asset enforcement, and the
/// per-pool max allocation cap.
contract V4LifecycleTest is V4Deployers {
    PoolRegistry internal registry;
    UniV4Adapter internal adapter;
    UniV4Adapter internal seedAdapter;
    ALPVault internal vault;

    MockERC20Token internal usdc;
    MockERC20Token internal weth;
    MockERC20Token internal dai;

    address internal token0;
    address internal token1;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");

    PoolKey internal poolKey;
    bytes32 internal poolKeyHash;

    uint24 internal constant FEE = 500;
    int24 internal constant TICK_SPACING = 10;

    function setUp() public {
        deployV4Stack();

        MockERC20Token tA = new MockERC20Token("USD Coin", "USDC", 18);
        MockERC20Token tB = new MockERC20Token("Wrapped Ether", "WETH", 18);
        if (uint160(address(tA)) < uint160(address(tB))) {
            usdc = tA;
            weth = tB;
        } else {
            usdc = tB;
            weth = tA;
        }
        dai = new MockERC20Token("DAI", "DAI", 18);
        token0 = address(usdc) < address(weth) ? address(usdc) : address(weth);
        token1 = address(usdc) < address(weth) ? address(weth) : address(usdc);

        registry = new PoolRegistry(owner, guardian);
        vault =
            new ALPVault(IERC20(address(usdc)), "ALP USDC Vault", "alpUSDC", registry, owner, address(this), guardian);
        adapter = new UniV4Adapter(positionManager, poolManager, swapRouter, permit2, address(vault));
        seedAdapter = new UniV4Adapter(positionManager, poolManager, swapRouter, permit2, address(this));

        PoolRegistry.Pool memory pool = PoolRegistry.Pool({
            adapter: address(adapter),
            token0: token0,
            token1: token1,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(0),
            maxAllocationBps: 10_000,
            enabled: true
        });
        vm.prank(guardian);
        poolKeyHash = registry.addPool(pool);
        vm.prank(guardian);
        vault.bootstrapAdapter(address(positionManager), address(adapter));

        poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        poolManager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));

        usdc.mint(alice, 1_000_000e18);
        weth.mint(alice, 1_000_000e18);
        usdc.mint(address(this), 1_000_000e18);
        weth.mint(address(this), 1_000_000e18);

        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        usdc.approve(address(seedAdapter), type(uint256).max);
        weth.approve(address(seedAdapter), type(uint256).max);
        seedAdapter.addLiquidity(
            registry.getPool(poolKeyHash),
            500_000e18,
            500_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
    }

    // -------- Hook restriction --------

    function test_addPool_withHooks_revertsAtRegistryLayer() public {
        // The first line of defence is the registry: hooked pools cannot
        // even be whitelisted. (The vault-side check at executeAddLiquidity
        // remains as belt-and-braces in case the registry is later relaxed.)
        address fakeHook = makeAddr("fakeHook");
        PoolRegistry.Pool memory pool = PoolRegistry.Pool({
            adapter: address(adapter),
            token0: token0,
            token1: token1,
            fee: 3000,
            tickSpacing: 60,
            hooks: fakeHook,
            maxAllocationBps: 10_000,
            enabled: true
        });
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.HookedPoolsNotAllowed.selector);
        registry.addPool(pool);
    }

    // -------- Orphan switch --------

    function test_setPoolOrphaned_excludesFromTotalAssets() public {
        // Open a position so the pool contributes to TAV.
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);
        vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        uint256 tavWithPool = vault.totalAssets();
        assertGt(tavWithPool, 0);

        // Guardian marks the pool as orphaned (e.g. underlying token started reverting).
        vm.prank(guardian);
        vault.setPoolOrphaned(poolKeyHash, true);

        // TAV now excludes the pool's contribution but still reflects idle base.
        uint256 idleBase = usdc.balanceOf(address(vault));
        assertEq(vault.totalAssets(), idleBase);
        assertTrue(vault.isPoolOrphaned(poolKeyHash));

        // Reversible.
        vm.prank(guardian);
        vault.setPoolOrphaned(poolKeyHash, false);
        assertEq(vault.totalAssets(), tavWithPool);
    }

    // -------- Base-asset constraint --------

    function test_executeAddLiquidity_revertsWhenBaseAssetNotInPool() public {
        // Register a pool that does NOT include USDC (the vault's base asset).
        address daiAddr = address(dai);
        address wethAddr = address(weth);
        (address t0, address t1) = daiAddr < wethAddr ? (daiAddr, wethAddr) : (wethAddr, daiAddr);
        PoolRegistry.Pool memory pool = PoolRegistry.Pool({
            adapter: address(adapter),
            token0: t0,
            token1: t1,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(0),
            maxAllocationBps: 10_000,
            enabled: true
        });
        vm.prank(guardian);
        bytes32 badKey = registry.addPool(pool);

        vm.expectRevert(abi.encodeWithSelector(ALPVault.BaseAssetNotInPool.selector, badKey));
        vault.executeAddLiquidity(
            badKey, 1e18, 1e18, 0, 0, abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
    }

    // -------- Soft-disable --------

    function test_softDisable_blocksNewAdd_butAllowsWindDown() public {
        // Open a position so the vault has something to wind down.
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        (uint256 positionId, uint128 liquidity,,) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // Guardian flips enabled=false.
        vm.prank(guardian);
        registry.setPoolEnabled(poolKeyHash, false);

        // New adds rejected.
        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotAddAllowed.selector, poolKeyHash));
        vault.executeAddLiquidity(
            poolKeyHash,
            1_000e18,
            1_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // Removal still works (uses the vault's snapshot).
        (uint256 out0, uint256 out1, bool burned) = vault.executeRemoveLiquidity(
            poolKeyHash, positionId, liquidity, 0, 0, abi.encode(block.timestamp + 600, true)
        );
        assertGt(out0 + out1, 0);
        assertTrue(burned);

        // Swaps still work — the agent may need them to clean up non-base balances.
        uint256 wethLeft = weth.balanceOf(address(vault));
        if (wethLeft > 0) {
            vault.executeSwap(poolKeyHash, address(weth), wethLeft, 1, abi.encode(block.timestamp + 600));
        }
    }

    // -------- Hard-remove --------

    function test_hardRemove_keepsExistingPositionWindDownPossible() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        (uint256 positionId, uint128 liquidity,,) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // Guardian removes the pool from the registry entirely.
        vm.prank(guardian);
        registry.removePool(poolKeyHash);

        // executeAdd / executeSwap now revert (pool not known to registry).
        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotAddAllowed.selector, poolKeyHash));
        vault.executeAddLiquidity(
            poolKeyHash,
            1_000e18,
            1_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotKnown.selector, poolKeyHash));
        vault.executeSwap(poolKeyHash, address(weth), 1, 1, abi.encode(block.timestamp + 600));

        // Removal STILL works — the vault's snapshot is independent of the
        // registry. This is what saves us from orphaned positions when a
        // guardian hard-removes a pool prematurely.
        (uint256 out0, uint256 out1, bool burned) = vault.executeRemoveLiquidity(
            poolKeyHash, positionId, liquidity, 0, 0, abi.encode(block.timestamp + 600, true)
        );
        assertGt(out0 + out1, 0);
        assertTrue(burned);

        // After burn, the pool is no longer tracked by the vault.
        assertEq(vault.positionCount(poolKeyHash), 0);
        assertEq(vault.getActivePools().length, 0);
    }

    // -------- Position tracking --------

    function test_positionTracking_addsAndRemoves() public {
        vm.prank(alice);
        vault.deposit(20_000e18, alice);
        weth.mint(address(vault), 20_000e18);

        (uint256 id1,,,) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
        (uint256 id2, uint128 liq2,,) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-3_000), int24(3_000), block.timestamp + 600, uint256(0))
        );

        assertEq(vault.positionCount(poolKeyHash), 2);
        uint256[] memory ids = vault.getPositionIds(poolKeyHash);
        assertEq(ids[0], id1);
        assertEq(ids[1], id2);
        assertEq(vault.getActivePools().length, 1);

        // Burn the second position; first should remain.
        vault.executeRemoveLiquidity(poolKeyHash, id2, liq2, 0, 0, abi.encode(block.timestamp + 600, true));
        assertEq(vault.positionCount(poolKeyHash), 1);
        assertEq(vault.getPositionIds(poolKeyHash)[0], id1);
        // Pool still active because id1 is still open.
        assertEq(vault.getActivePools().length, 1);
    }

    function test_closeAllPositionsInPool_byAgent_burnsEverything() public {
        vm.prank(alice);
        vault.deposit(20_000e18, alice);
        weth.mint(address(vault), 20_000e18);

        vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
        vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-3_000), int24(3_000), block.timestamp + 600, uint256(0))
        );
        assertEq(vault.positionCount(poolKeyHash), 2);

        vault.closeAllPositionsInPool(poolKeyHash, block.timestamp + 600);

        assertEq(vault.positionCount(poolKeyHash), 0);
        assertEq(vault.getActivePools().length, 0);
        // Vault now holds only base + non-base token balances; no open positions.
    }

    function test_closeAllPositionsInPool_byGuardian_works() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        vm.prank(guardian);
        vault.closeAllPositionsInPool(poolKeyHash, block.timestamp + 600);

        assertEq(vault.positionCount(poolKeyHash), 0);
    }

    function test_closeAllPositionsInPool_byStranger_reverts() public {
        vm.expectRevert(ALPVault.NotAgentOrGuardian.selector);
        vm.prank(alice);
        vault.closeAllPositionsInPool(poolKeyHash, block.timestamp + 600);
    }

    function test_closeAllPositionsInPool_runsEvenWhilePaused() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        vm.prank(guardian);
        vault.pause();

        // Even while paused, the guardian can still wind down emergency-style.
        vm.prank(guardian);
        vault.closeAllPositionsInPool(poolKeyHash, block.timestamp + 600);
        assertEq(vault.positionCount(poolKeyHash), 0);
    }

    // -------- Adapter coverage extensions --------

    function test_increaseLiquidity_onExistingPosition() public {
        vm.prank(alice);
        vault.deposit(20_000e18, alice);
        weth.mint(address(vault), 20_000e18);

        // First mint a position.
        (uint256 positionId, uint128 liquidityBefore,,) = vault.executeAddLiquidity(
            poolKeyHash,
            2_000e18,
            2_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // Increase by passing existingPositionId.
        (uint256 sameId, uint128 added,,) = vault.executeAddLiquidity(
            poolKeyHash,
            1_000e18,
            1_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, positionId)
        );
        assertEq(sameId, positionId, "positionId should be reused");
        assertGt(added, 0, "should have added liquidity");
        assertGt(adapter.getPositionLiquidity(registry.getPool(poolKeyHash), positionId), liquidityBefore);
        assertEq(vault.positionCount(poolKeyHash), 1, "still one position tracked");
    }

    function test_executeCollectFees_addsBaseSideToBookTAV() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        (uint256 positionId,,,) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // Drive fees through the pool.
        usdc.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        for (uint256 i = 0; i < 3; i++) {
            swapRouter.swapExactTokensForTokens(5_000e18, 0, true, poolKey, "", address(this), block.timestamp + 60);
            swapRouter.swapExactTokensForTokens(5_000e18, 0, false, poolKey, "", address(this), block.timestamp + 60);
        }

        uint256 bookBefore = vault.bookTAV();
        (uint256 fee0, uint256 fee1) = vault.executeCollectFees(poolKeyHash, positionId);
        assertGt(fee0 + fee1, 0, "fees collected");
        // bookTAV grows by the base-side amount only (USDC is base).
        uint256 expectedBump = address(usdc) == token0 ? fee0 : fee1;
        assertEq(vault.bookTAV() - bookBefore, expectedBump, "bookTAV should match base-side fees");
    }

    function test_autoUnwind_onWithdrawShortfall() public {
        // Alice deposits 10k USDC and the agent moves all of it into a position.
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        // Agent: swap half to WETH, then add the position with both sides.
        uint256 amtOut = vault.executeSwap(poolKeyHash, address(usdc), 5_000e18, 1, abi.encode(block.timestamp + 600));
        assertGt(amtOut, 0);
        vault.executeAddLiquidity(
            poolKeyHash,
            usdc.balanceOf(address(vault)),
            weth.balanceOf(address(vault)),
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
        // Idle base now ~= 0, all value in the position.
        assertLt(usdc.balanceOf(address(vault)), 100e18, "expected most of base to be in the position");

        // Alice tries to redeem half her shares. Idle base is short → auto-unwind kicks in.
        vm.roll(block.number + 1);
        uint256 sharesToBurn = vault.balanceOf(alice) / 2;
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 received = vault.redeem(sharesToBurn, alice, alice);
        assertGt(received, 0, "auto-unwind should have produced base");
        assertGt(usdc.balanceOf(alice), aliceBefore);
    }

    // -------- Slippage-protected wrappers --------

    function test_depositWithMin_revertsWhenSharesBelowMin() public {
        // Demand absurdly many shares from a 100 USDC deposit; reverts.
        vm.prank(alice);
        vm.expectRevert();
        vault.depositWithMin(100e18, alice, type(uint256).max);
    }

    function test_depositWithMin_passesWhenSharesAboveMin() public {
        vm.prank(alice);
        uint256 shares = vault.depositWithMin(100e18, alice, 1);
        assertGt(shares, 1);
    }

    function test_redeemWithMin_revertsWhenAssetsBelowMin() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        vm.roll(block.number + 1);
        // Demand absurd minimum on the way out. Stash shares first so the
        // prank survives to the actual redeem.
        uint256 shares = vault.balanceOf(alice);
        vm.expectRevert();
        vm.prank(alice);
        vault.redeemWithMin(shares, alice, alice, type(uint256).max);
    }

    function test_withdrawWithMax_revertsWhenSharesAboveMax() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        vm.roll(block.number + 1);
        vm.prank(alice);
        // Cap shares burnt to 1 — withdraw of 100 USDC needs more than that.
        vm.expectRevert();
        vault.withdrawWithMax(100e18, alice, alice, 1);
    }

    function test_mintWithMax_revertsWhenAssetsAboveMax() public {
        // Mint a tiny share count for at most 1 wei of USDC.
        vm.prank(alice);
        vm.expectRevert();
        vault.mintWithMax(1e24, alice, 1);
    }

    // -------- Cross-pool routing (swap in pool A, LP in pool B) --------

    function test_crossPool_swapInOnePool_addLiquidityInAnother() public {
        // Register a SECOND pool — same pair, different fee tier — so we
        // can prove the agent freely chooses which pool to swap through
        // vs which pool to LP into.
        // (V4 supports multiple pools per pair; we use fee=3000 here vs the
        // default 500 from setUp.)
        PoolRegistry.Pool memory pool2 = PoolRegistry.Pool({
            adapter: address(adapter),
            token0: token0,
            token1: token1,
            hooks: address(0),
            fee: 3000,
            tickSpacing: 60,
            maxAllocationBps: 10_000,
            enabled: true
        });
        vm.prank(guardian);
        bytes32 pool2Hash = registry.addPool(pool2);

        PoolKey memory poolKey2 = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        poolManager.initialize(poolKey2, TickMath.getSqrtPriceAtTick(0));

        // Seed deep external liquidity in pool2 so swaps don't slip badly.
        seedAdapter.addLiquidity(
            registry.getPool(pool2Hash),
            500_000e18,
            500_000e18,
            0,
            0,
            abi.encode(int24(-12_000), int24(12_000), block.timestamp + 600, uint256(0))
        );

        // Alice deposits 10k USDC.
        vm.prank(alice);
        vault.deposit(10_000e18, alice);

        // Agent swaps THROUGH pool2 (deeper) but LPs INTO pool 1 (the
        // original pool). The vault doesn't constrain the agent to use
        // the same pool for both legs.
        vault.executeSwap(pool2Hash, address(usdc), 4_000e18, 1, abi.encode(block.timestamp + 60));
        (uint256 positionId,,,) = vault.executeAddLiquidity(
            poolKeyHash,
            usdc.balanceOf(address(vault)) / 2,
            weth.balanceOf(address(vault)) / 2,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 60, uint256(0))
        );
        // Position lives under poolKeyHash (the original 0.05% pool), even
        // though the swap that funded its non-base side ran through pool2.
        assertEq(IERC721(address(positionManager)).ownerOf(positionId), address(vault));
        assertEq(vault.positionCount(poolKeyHash), 1);
        assertEq(vault.positionCount(pool2Hash), 0);
    }

    // -------- In-kind redemption (illiquid-pool escape hatch) --------

    function test_redeemInKind_paysProRataAcrossEveryToken() public {
        // Alice in.
        vm.prank(alice);
        vault.deposit(20_000e18, alice);
        // Open a position so the vault holds both base and non-base inside
        // an LP. Some idle non-base too so the redeemer gets a slice of
        // both rails.
        vault.executeSwap(poolKeyHash, address(usdc), 4_000e18, 1, abi.encode(block.timestamp + 60));
        vault.executeAddLiquidity(
            poolKeyHash,
            4_000e18,
            weth.balanceOf(address(vault)) / 2,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 60, uint256(0))
        );

        vm.roll(block.number + 1);

        // Alice redeems half her shares in-kind. She should receive USDC
        // (idle) + WETH (idle leftover from the swap + the proportional
        // share of the position's WETH that the peel just released).
        uint256 sharesToRedeem = vault.balanceOf(alice) / 2;
        address[] memory expectedTokens = new address[](2);
        uint256[] memory minAmounts = new uint256[](2);
        expectedTokens[0] = address(usdc);
        expectedTokens[1] = address(weth);
        minAmounts[0] = 1; // any positive amount of USDC
        minAmounts[1] = 1; // any positive amount of WETH

        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 wethBefore = weth.balanceOf(alice);

        vm.prank(alice);
        vault.redeemInKind(sharesToRedeem, alice, alice, expectedTokens, minAmounts);

        assertGt(usdc.balanceOf(alice), usdcBefore, "alice should receive USDC pro-rata");
        assertGt(weth.balanceOf(alice), wethBefore, "alice should receive WETH pro-rata from the position");
    }

    function test_redeemInKind_revertsWhenMinNotMet() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        vm.roll(block.number + 1);

        address[] memory expectedTokens = new address[](1);
        uint256[] memory minAmounts = new uint256[](1);
        expectedTokens[0] = address(usdc);
        minAmounts[0] = 1_000_000e18; // way more than alice owns

        uint256 shares = vault.balanceOf(alice);
        vm.expectRevert();
        vm.prank(alice);
        vault.redeemInKind(shares, alice, alice, expectedTokens, minAmounts);
    }

    function test_redeemInKind_arrayMismatch_reverts() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        vm.roll(block.number + 1);

        address[] memory expectedTokens = new address[](2);
        uint256[] memory minAmounts = new uint256[](1);
        expectedTokens[0] = address(usdc);
        expectedTokens[1] = address(weth);
        minAmounts[0] = 1;

        vm.expectRevert(ALPVault.InKindArrayMismatch.selector);
        vm.prank(alice);
        vault.redeemInKind(1, alice, alice, expectedTokens, minAmounts);
    }

    function test_partialRemove_keepsPositionTracked() public {
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        (uint256 id, uint128 liquidity,,) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // Partial removal — should NOT untrack.
        (,, bool burned) =
            vault.executeRemoveLiquidity(poolKeyHash, id, liquidity / 2, 0, 0, abi.encode(block.timestamp + 600, false));
        assertFalse(burned);
        assertEq(vault.positionCount(poolKeyHash), 1);
        assertEq(vault.getActivePools().length, 1);
    }

    // -------- Max allocation cap --------

    function test_maxAllocationBps_capsAdd() public {
        // Tighten cap to 30%.
        vm.prank(guardian);
        registry.setPoolMaxAllocation(poolKeyHash, 3_000);

        // Deposit 10k USDC and provide WETH side.
        vm.prank(alice);
        vault.deposit(10_000e18, alice);
        weth.mint(address(vault), 10_000e18);

        // The cap is measured against `totalAssets()` which under dual-rail
        // returns MIN(book, market). bookTAV here is alice's 10k deposit,
        // so a 5k+5k add (≈ 10k position value) is 100% of the floor and
        // must revert at the 30% cap.
        vm.expectRevert(abi.encodeWithSelector(ALPVault.MaxAllocationExceeded.selector, poolKeyHash));
        vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        // 1k+1k ≈ 2k position value = 20% of the 10k bookTAV floor — under cap.
        vault.executeAddLiquidity(
            poolKeyHash,
            1_000e18,
            1_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
        assertEq(vault.positionCount(poolKeyHash), 1);
    }
}
