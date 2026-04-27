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

        uint256 amountOut = vault.executeSwap(poolKeyHash, USDC, 100e6, 1, "");

        assertGt(amountOut, 0);
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultUsdcBefore - 100e6);
        assertEq(IERC20(WETH).balanceOf(address(vault)), vaultWethBefore + amountOut);
    }

    function test_v3_collectFees_growsBookTAV() public {
        vm.prank(alice);
        vault.deposit(20_000e6, alice);
        vault.executeSwap(poolKeyHash, USDC, 5_000e6, 1, "");

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
        vault.executeSwap(poolKeyHash, USDC, 10_000e6, 1, "");

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
        uint256 wethReceived = vault.executeSwap(poolKeyHash, USDC, 10_000e6, 1, "");
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
            vault.executeSwap(poolKeyHash, WETH, wethLeft, 1, "");
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
}
