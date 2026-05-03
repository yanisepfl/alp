// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

import {ALPVault} from "../../src/ALPVault.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {UniversalRouterAdapter} from "../../src/adapters/UniversalRouterAdapter.sol";
import {IUniversalRouter} from "../../src/interfaces/external/IUniversalRouter.sol";
import {IUniswapV3Factory} from "../../src/interfaces/external/IUniswapV3Factory.sol";

/// @notice Fork test against Base mainnet exercising the Universal Router
/// adapter against the live Universal Router and a real V3 pool.
///
/// Run with:
///   BASE_RPC_URL=<rpc> forge test --match-path test/integration/URAdapterForkIntegration.t.sol
///
/// Without `BASE_RPC_URL` set every test in the suite is skipped.
contract URAdapterForkIntegrationTest is Test {
    // Canonical Base mainnet addresses
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Universal Router command byte for V3 exact-input swap.
    // See https://docs.uniswap.org/contracts/universal-router/technical-reference
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    // Reserved recipient sentinel: send output to msg.sender (i.e. our adapter).
    address internal constant MSG_SENDER = 0x0000000000000000000000000000000000000001;

    PoolRegistry internal registry;
    UniversalRouterAdapter internal urAdapter;
    ALPVault internal vault;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");

    bytes32 internal usdcWethKey;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        registry = new PoolRegistry(owner, guardian);
        vault = new ALPVault(IERC20(USDC), "ALPS USDC Vault", "alpUSDC", registry, owner, address(this), guardian);
        urAdapter = new UniversalRouterAdapter(
            IUniversalRouter(UNIVERSAL_ROUTER), IPermit2(PERMIT2), IUniswapV3Factory(V3_FACTORY), address(vault)
        );

        // Register the URAdapter "router pool" for the WETH/USDC pair. Token
        // ordering must satisfy `token0 < token1`. The pool params point at
        // the canonical V3 0.05% pool so `getSpotSqrtPriceX96` resolves.
        (address t0, address t1) = WETH < USDC ? (WETH, USDC) : (USDC, WETH);
        PoolRegistry.Pool memory poolEntry = PoolRegistry.Pool({
            adapter: address(urAdapter),
            token0: t0,
            token1: t1,
            fee: 500,
            tickSpacing: 10,
            hooks: address(0),
            maxAllocationBps: 1, // unused by URAdapter; min legal value
            enabled: false // URAdapter pools are swap-only (isPoolKnown=true is enough)
        });
        vm.prank(guardian);
        usdcWethKey = registry.addPool(poolEntry);
    }

    // -------- positive flows --------

    function test_uradapter_singleHopV3SwapDelivers() public {
        // Seed the vault with USDC and ask UR to swap to WETH through the V3
        // 0.05% pool. We construct the calldata by hand here; in production
        // the agent gets it from the Uniswap Trading API.
        deal(USDC, address(vault), 1_000e6);

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, uint24(500), WETH);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            MSG_SENDER, // recipient = adapter; adapter sweeps to vault
            uint256(100e6),
            uint256(1), // amountOutMin (assertion is repeated by adapter)
            path,
            true // payerIsUser → UR pulls from adapter via Permit2
        );

        bytes memory extra = abi.encode(commands, inputs, block.timestamp + 600);

        uint256 wethBefore = IERC20(WETH).balanceOf(address(vault));
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(vault));

        uint256 amountOut = vault.executeSwap(usdcWethKey, USDC, 100e6, 1, extra);

        assertGt(amountOut, 0, "UR returned zero output");
        assertEq(IERC20(USDC).balanceOf(address(vault)), usdcBefore - 100e6, "USDC delta wrong");
        assertEq(IERC20(WETH).balanceOf(address(vault)), wethBefore + amountOut, "WETH credit wrong");
    }

    function test_uradapter_revertsBelowMinOut() public {
        deal(USDC, address(vault), 1_000e6);

        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, uint24(500), WETH);
        bytes[] memory inputs = new bytes[](1);
        // Set the UR-internal minOut tiny so UR itself doesn't revert; rely on
        // the adapter's own balance-delta assertion to enforce our floor.
        inputs[0] = abi.encode(MSG_SENDER, uint256(100e6), uint256(1), path, true);
        bytes memory extra = abi.encode(commands, inputs, block.timestamp + 600);

        // Demand more WETH out than 100 USDC could ever buy.
        uint256 unreachableMinOut = 10e18;

        vm.expectRevert();
        vault.executeSwap(usdcWethKey, USDC, 100e6, unreachableMinOut, extra);
    }

    function test_uradapter_directCallerRejected() public {
        // Even with valid calldata, a non-vault caller hits NotVault before
        // anything else runs.
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, uint24(500), WETH);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(MSG_SENDER, uint256(100e6), uint256(1), path, true);
        bytes memory extra = abi.encode(commands, inputs, block.timestamp + 600);

        (address t0, address t1) = WETH < USDC ? (WETH, USDC) : (USDC, WETH);
        PoolRegistry.Pool memory poolEntry = PoolRegistry.Pool({
            adapter: address(urAdapter),
            token0: t0,
            token1: t1,
            fee: 500,
            tickSpacing: 10,
            hooks: address(0),
            maxAllocationBps: 1,
            enabled: false
        });

        vm.expectRevert(UniversalRouterAdapter.NotVault.selector);
        urAdapter.swapExactIn(poolEntry, USDC, 100e6, 1, extra);
    }
}
