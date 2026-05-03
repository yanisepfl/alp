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

/// @notice End-to-end test for the V4 path:
///   1. Local Permit2 + PoolManager + PositionManager + V4SwapRouter via hookmate.
///   2. Initialise a USDC/WETH pool at 1:1.
///   3. Test contract acts as an "external LP" to seed liquidity (so swaps have a counterparty).
///   4. Alice deposits USDC into the vault.
///   5. The test contract acts as the agent: swaps USDC→WETH inside the vault, mints a position,
///      executes a swap that drives fees, removes the position, collects fees.
///   6. Alice withdraws and we verify she gets back what the vault now holds.
///
/// Pool token0/token1 ordering matters for V4. We sort the mock tokens up-front.
contract UniV4IntegrationTest is V4Deployers {
    PoolRegistry internal registry;
    UniV4Adapter internal adapter;
    UniV4Adapter internal seedAdapter;
    ALPVault internal vault;

    MockERC20Token internal usdc;
    MockERC20Token internal weth;

    // sorted token order — assigned in setUp after we know the mock addresses
    address internal token0;
    address internal token1;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");

    PoolKey internal poolKey;
    bytes32 internal poolKeyHash;

    uint24 internal constant FEE = 500; // 0.05%
    int24 internal constant TICK_SPACING = 10;

    function setUp() public {
        deployV4Stack();

        // Two mock 18-dec tokens. We use 18 decimals on both so tick math is clean.
        MockERC20Token tA = new MockERC20Token("USD Coin", "USDC", 18);
        MockERC20Token tB = new MockERC20Token("Wrapped Ether", "WETH", 18);
        if (uint160(address(tA)) < uint160(address(tB))) {
            usdc = tA;
            weth = tB;
        } else {
            usdc = tB;
            weth = tA;
        }
        token0 = address(usdc) < address(weth) ? address(usdc) : address(weth);
        token1 = address(usdc) < address(weth) ? address(weth) : address(usdc);

        // Vault stack — vault asset is USDC. Vault deploys before the
        // adapter so the adapter can pin the vault address as immutable.
        registry = new PoolRegistry(owner, guardian);
        vault =
            new ALPVault(IERC20(address(usdc)), "ALPS USDC Vault", "alpUSDC", registry, owner, address(this), guardian);
        adapter = new UniV4Adapter(positionManager, poolManager, swapRouter, permit2, address(vault));

        // Second adapter with this test contract as the "vault" — used only
        // to seed the pool with external liquidity so swap tests have a
        // counterparty. Production paths route exclusively through `adapter`.
        seedAdapter = new UniV4Adapter(positionManager, poolManager, swapRouter, permit2, address(this));

        // I (the test contract) act as the agent for simplicity.
        // Guardian whitelists the pool + bootstraps the adapter for V4 NFTs.
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
        vm.startPrank(guardian);
        poolKeyHash = registry.addPool(pool);
        vm.stopPrank();

        vm.prank(guardian);
        vault.bootstrapAdapter(address(positionManager), address(adapter));

        // V4 pool init at sqrtPrice = 1 (price 1:1)
        poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        poolManager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0)); // price = 1

        // Mint a stash to alice + to the test contract (external LP + a way to swap)
        usdc.mint(alice, 1_000_000e18);
        weth.mint(alice, 1_000_000e18);
        usdc.mint(address(this), 1_000_000e18);
        weth.mint(address(this), 1_000_000e18);

        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        // Seed external liquidity using the same adapter (acting as a third-party LP).
        // The adapter pulls from msg.sender (the test contract) and mints the NFT to
        // the test contract; the adapter handles its own permit2 setup.
        usdc.approve(address(seedAdapter), type(uint256).max);
        weth.approve(address(seedAdapter), type(uint256).max);
        PoolRegistry.Pool memory poolStruct = registry.getPool(poolKeyHash);
        seedAdapter.addLiquidity(
            poolStruct,
            500_000e18,
            500_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
    }

    // -------- positive flow --------

    function test_addLiquidity_mintsPositionToVault() public {
        // Alice deposits 10k USDC
        vm.prank(alice);
        vault.deposit(10_000e18, alice);

        // Move some WETH directly into the vault to demonstrate two-sided LP.
        // Production: vault would executeSwap USDC->WETH first (covered by the full-flow test).
        weth.mint(address(vault), 10_000e18);

        uint256 nftCountBefore = positionManager.nextTokenId();

        (uint256 positionId, uint128 liquidity, uint256 used0, uint256 used1) = vault.executeAddLiquidity(
            poolKeyHash,
            5_000e18,
            5_000e18,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );

        assertEq(positionId, nftCountBefore, "positionId mismatch");
        assertGt(liquidity, 0, "liquidity should be > 0");
        assertGt(used0, 0, "used0 should be > 0");
        assertGt(used1, 0, "used1 should be > 0");
        assertLe(used0, 5_000e18);
        assertLe(used1, 5_000e18);

        // Vault must own the position NFT.
        assertEq(IERC721(address(positionManager)).ownerOf(positionId), address(vault));
    }

    function test_swap_throughVault_movesTokens() public {
        // Mint WETH directly to the vault — we want to swap WETH for USDC.
        weth.mint(address(vault), 1_000e18);

        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));
        uint256 vaultWethBefore = weth.balanceOf(address(vault));

        uint256 amountOut = vault.executeSwap(poolKeyHash, address(weth), 100e18, 1, abi.encode(block.timestamp + 600));

        assertGt(amountOut, 0, "swap should yield non-zero output");
        assertEq(weth.balanceOf(address(vault)), vaultWethBefore - 100e18);
        assertEq(usdc.balanceOf(address(vault)), vaultUsdcBefore + amountOut);
    }

    function test_removeLiquidity_returnsTokensToVault() public {
        // Set up a position first.
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

        uint256 usdcBefore = usdc.balanceOf(address(vault));
        uint256 wethBefore = weth.balanceOf(address(vault));

        (uint256 out0, uint256 out1, bool burned) = vault.executeRemoveLiquidity(
            poolKeyHash, positionId, liquidity, 0, 0, abi.encode(block.timestamp + 600, true)
        );

        assertGt(out0, 0);
        assertGt(out1, 0);
        assertTrue(burned, "position should be burned");
        assertGt(usdc.balanceOf(address(vault)), usdcBefore);
        assertGt(weth.balanceOf(address(vault)), wethBefore);
        // Vault drops the position from tracking after burn.
        assertEq(vault.positionCount(poolKeyHash), 0);
        assertEq(vault.getActivePools().length, 0);
    }

    function test_collectFees_afterExternalSwap_returnsFees() public {
        // Vault opens a position
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

        // Drive fees by swapping back and forth through the pool from the test contract.
        usdc.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        for (uint256 i = 0; i < 5; i++) {
            swapRouter.swapExactTokensForTokens(10_000e18, 0, true, poolKey, "", address(this), block.timestamp + 60);
            swapRouter.swapExactTokensForTokens(10_000e18, 0, false, poolKey, "", address(this), block.timestamp + 60);
        }

        uint256 usdcBefore = usdc.balanceOf(address(vault));
        uint256 wethBefore = weth.balanceOf(address(vault));
        (uint256 fee0, uint256 fee1) = vault.executeCollectFees(poolKeyHash, positionId);

        assertGt(fee0 + fee1, 0, "no fees collected");
        assertEq(usdc.balanceOf(address(vault)), usdcBefore + (token0 == address(usdc) ? fee0 : fee1));
        assertEq(weth.balanceOf(address(vault)), wethBefore + (token0 == address(weth) ? fee0 : fee1));
    }

    // -------- agent simulation: full lifecycle --------

    /// @notice Simulates a full agent-driven cycle (no real agent yet — the test
    /// contract plays the agent). Proves the on-chain surface the agent will
    /// drive end-to-end: deposit → swap → add LP → external trades → collect fees
    /// → remove LP → withdraw.
    function test_agentLifecycle_fullCycle() public {
        // 1. User deposits 20k USDC
        vm.prank(alice);
        vault.deposit(20_000e18, alice);
        assertEq(vault.totalAssets(), 20_000e18);

        // 2. Agent swaps 10k USDC -> WETH inside the vault
        uint256 wethReceived =
            vault.executeSwap(poolKeyHash, address(usdc), 10_000e18, 1, abi.encode(block.timestamp + 600));
        assertGt(wethReceived, 0);

        // 3. Agent adds liquidity using both sides
        uint256 vaultUsdc = usdc.balanceOf(address(vault));
        uint256 vaultWeth = weth.balanceOf(address(vault));

        (uint256 positionId, uint128 liquidity,,) = vault.executeAddLiquidity(
            poolKeyHash,
            vaultUsdc,
            vaultWeth,
            0,
            0,
            abi.encode(int24(-6_000), int24(6_000), block.timestamp + 600, uint256(0))
        );
        assertEq(IERC721(address(positionManager)).ownerOf(positionId), address(vault));

        // 4. External trades drive fees through the pool
        usdc.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        for (uint256 i = 0; i < 3; i++) {
            swapRouter.swapExactTokensForTokens(5_000e18, 0, true, poolKey, "", address(this), block.timestamp + 60);
            swapRouter.swapExactTokensForTokens(5_000e18, 0, false, poolKey, "", address(this), block.timestamp + 60);
        }

        // 5. Agent removes the position (this also collects accrued fees in the same flow)
        vault.executeRemoveLiquidity(poolKeyHash, positionId, liquidity, 0, 0, abi.encode(block.timestamp + 600, true));

        // 6. Agent rebalances — swap WETH back to USDC so the vault is mostly USDC for withdraw
        uint256 wethLeft = weth.balanceOf(address(vault));
        if (wethLeft > 0) {
            vault.executeSwap(poolKeyHash, address(weth), wethLeft, 1, abi.encode(block.timestamp + 600));
        }

        // 7. Alice withdraws everything
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 maxRedeem = vault.maxRedeem(alice);
        assertEq(maxRedeem, aliceShares);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        // Same-block-mint-and-redeem lockout: advance the block before alice
        // exits her position.
        vm.roll(block.number + 1);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 aliceUsdcAfter = usdc.balanceOf(alice);

        // Alice should get back roughly her deposit ± LP fees ± swap fees on the round-trip.
        // We don't assert exact equality (round-trip swap costs ~0.1% in fees twice),
        // but she should retrieve at least 99% of her principal in this simulated env.
        uint256 received = aliceUsdcAfter - aliceUsdcBefore;
        assertGe(received, (20_000e18 * 990) / 1000, "alice lost too much on the round trip");
    }
}
