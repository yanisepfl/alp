// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";

import {ALPVault} from "../src/ALPVault.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {UniV3Adapter} from "../src/adapters/UniV3Adapter.sol";
import {UniV4Adapter} from "../src/adapters/UniV4Adapter.sol";
import {UniversalRouterAdapter} from "../src/adapters/UniversalRouterAdapter.sol";
import {INonfungiblePositionManager} from "../src/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/external/ISwapRouter02.sol";
import {IUniswapV3Factory} from "../src/interfaces/external/IUniswapV3Factory.sol";
import {IUniversalRouter} from "../src/interfaces/external/IUniversalRouter.sol";

/// @notice One-shot bootstrap of the ALP stack against an Anvil fork of Base
/// mainnet. Deploys all contracts, registers the V3 USDC/cbBTC + V3 USDC/USDT
/// LP pools and three URAdapter swap entries, allowlists the Alphix hook
/// (for future use once native-ETH support lands in V4Adapter), and seeds an
/// in-range V3 USDC/cbBTC position so the agent has something to monitor.
///
/// The script does NOT fund USDC itself — `scripts/local-fork.sh` pre-funds
/// the deployer via anvil storage manipulation before running the script.
/// The deployer then `vault.deposit`s the USDC inside this script, after
/// which the agent (anvil account 1) opens the position.
///
/// Output: prints every deployed address + each registered pool key in a
/// `# AGENT_ENV` block ready to be copy-pasted into `agent/.env`.
contract LocalBootstrap is Script {
    // -------- Base mainnet pinned addresses --------
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant ETH_NATIVE = address(0);

    address constant V3_NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    address constant V4_POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address constant V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant V4_SWAP_ROUTER = 0x15c40591096E938FE2A62515A7f4B8f4349D1DEE; // hookmate Base
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    // Alphix V4 ETH/USDC pool config from the team brief
    address constant ALPHIX_HOOK = 0x7cBbfF9C4fcd74B221C535F4fB4B1Db04F1B9044;
    int24 constant ALPHIX_TICK_SPACING = 60;
    uint24 constant ALPHIX_FEE = 499;

    // Anvil default funded accounts
    address constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant AGENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 constant AGENT_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    // Seed amount (10k USDC)
    uint256 constant SEED_USDC = 10_000e6;

    function run() external {
        // -------- Phase 1: deploy + register (deployer key) --------
        vm.startBroadcast(DEPLOYER_KEY);
        PoolRegistry registry = new PoolRegistry(DEPLOYER, DEPLOYER);
        ALPVault vault = new ALPVault(IERC20(USDC), "ALP USDC Vault", "alpUSDC", registry, DEPLOYER, AGENT, DEPLOYER);

        UniV3Adapter v3Adapter = new UniV3Adapter(
            INonfungiblePositionManager(V3_NPM),
            ISwapRouter02(V3_SWAP_ROUTER),
            IUniswapV3Factory(V3_FACTORY),
            address(vault)
        );

        UniV4Adapter v4Adapter = new UniV4Adapter(
            IPositionManager(V4_POSITION_MANAGER),
            IPoolManager(V4_POOL_MANAGER),
            IUniswapV4Router04(payable(V4_SWAP_ROUTER)),
            IPermit2(PERMIT2),
            address(vault)
        );

        UniversalRouterAdapter urAdapter = new UniversalRouterAdapter(
            IUniversalRouter(UNIVERSAL_ROUTER), IPermit2(PERMIT2), IUniswapV3Factory(V3_FACTORY), address(vault)
        );

        registry.setHookAllowed(ALPHIX_HOOK, true);
        vault.bootstrapAdapter(V3_NPM, address(v3Adapter));
        vault.bootstrapAdapter(V4_POSITION_MANAGER, address(v4Adapter));

        // LP-pool entries (one per real pool)
        // NOTE: the Alphix V4 ETH/USDC pool (hook 0x7cBb...9044, allowlisted
        // above) uses native ETH as token0. Registering it requires loosening
        // PoolRegistry's `token0 != address(0)` invariant AND adding native-ETH
        // support to UniV4Adapter (currently does IERC20.safeTransferFrom on
        // both tokens). Out of scope for the demo bootstrap; the hook
        // allowlist plumbing is in place for any ERC20-paired hooked pool.
        bytes32 cbbtcKey = registry.addPool(
            _pool(address(v3Adapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10, address(0), true)
        );
        bytes32 usdtKey =
            registry.addPool(_pool(address(v3Adapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1, address(0), true));

        // URAdapter swap-only entries (one per pair we expect to swap)
        bytes32 urEthKey = registry.addPool(
            _pool(address(urAdapter), _low(USDC, WETH), _high(USDC, WETH), 500, 10, address(0), false)
        );
        bytes32 urCbbtcKey = registry.addPool(
            _pool(address(urAdapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10, address(0), false)
        );
        bytes32 urUsdtKey =
            registry.addPool(_pool(address(urAdapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1, address(0), false));

        // -------- Phase 2: deployer deposits USDC into the vault --------
        // The shell wrapper pre-funded DEPLOYER with USDC via anvil storage
        // manipulation. Now DEPLOYER approves and deposits — vault holds the
        // USDC and DEPLOYER holds shares.
        IERC20(USDC).approve(address(vault), SEED_USDC);
        vault.deposit(SEED_USDC, DEPLOYER);
        vm.stopBroadcast();

        // -------- Phase 3: agent opens an in-range V3 USDC/cbBTC position --------
        vm.startBroadcast(AGENT_KEY);

        // 1. Swap 5k USDC → cbBTC through the cbBTC LP pool itself
        // (single-hop V3 swap via UniV3Adapter). amountOutMin=1 because we
        // accept any non-zero output for the seed; production agent uses real
        // slippage tolerance.
        vault.executeSwap(cbbtcKey, USDC, SEED_USDC / 2, 1, "");

        // 2. Add liquidity full-range so the position is definitely in-range
        // at the current spot. Real agent sets a tighter range; the
        // bootstrap goes wide so we don't have to compute spot ticks.
        uint256 vaultUsdcAfterSwap = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultCbbtcAfterSwap = IERC20(CBBTC).balanceOf(address(vault));

        // Token0/token1 ordering for the cbBTC pool (CBBTC < USDC numerically)
        address t0 = _low(USDC, CBBTC);
        bool usdcIsToken0 = (t0 == USDC);
        uint256 amount0 = usdcIsToken0 ? vaultUsdcAfterSwap : vaultCbbtcAfterSwap;
        uint256 amount1 = usdcIsToken0 ? vaultCbbtcAfterSwap : vaultUsdcAfterSwap;

        vault.executeAddLiquidity(
            cbbtcKey,
            amount0,
            amount1,
            0,
            0,
            // V3 add encoding: tickLower, tickUpper, deadline, existingPositionId
            // Wide range: [-887270, 887270] is the V3 max range modulo spacing.
            // For tickSpacing=10: floor(-887270/10)*10 = -887270, ceil(887270/10)*10 = 887270.
            abi.encode(int24(-887_270), int24(887_270), block.timestamp + 600, uint256(0))
        );
        vm.stopBroadcast();

        // -------- Phase 4: print env block --------
        console2.log("");
        console2.log("# === AGENT_ENV (paste into agent/.env) ===");
        console2.log("BASE_RPC_URL=http://localhost:8545");
        console2.log("VAULT_ADDRESS=", address(vault));
        console2.log("REGISTRY_ADDRESS=", address(registry));
        console2.log("V3_ADAPTER_ADDRESS=", address(v3Adapter));
        console2.log("V4_ADAPTER_ADDRESS=", address(v4Adapter));
        console2.log("UR_ADAPTER_ADDRESS=", address(urAdapter));
        console2.log("AGENT_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        console2.log("");
        console2.log("# Pool keys");
        console2.log("V3_USDC_CBBTC_KEY=  ", uint256(cbbtcKey));
        console2.log("V3_USDC_USDT_KEY=   ", uint256(usdtKey));
        console2.log("UR_USDC_WETH_KEY=   ", uint256(urEthKey));
        console2.log("UR_USDC_CBBTC_KEY=  ", uint256(urCbbtcKey));
        console2.log("UR_USDC_USDT_KEY=   ", uint256(urUsdtKey));
        console2.log("");
        console2.log("# Vault state");
        console2.log("vault USDC balance:", IERC20(USDC).balanceOf(address(vault)));
        console2.log("vault CBBTC balance:", IERC20(CBBTC).balanceOf(address(vault)));
        console2.log("vault tracked positions in cbBTC pool: 1 (full-range, in-range)");
    }

    function _pool(address adapter, address t0, address t1, uint24 fee, int24 spacing, address hook, bool enabled)
        internal
        pure
        returns (PoolRegistry.Pool memory)
    {
        return PoolRegistry.Pool({
            adapter: adapter,
            token0: t0,
            token1: t1,
            fee: fee,
            tickSpacing: spacing,
            hooks: hook,
            // Demo bootstrap: 10_000 (100%) so a single seed position can
            // sit alone in a pool without tripping the per-pool allocation
            // cap. Production guardian sets this much tighter per pool.
            maxAllocationBps: enabled ? uint16(10_000) : uint16(1),
            enabled: enabled
        });
    }

    function _low(address a, address b) internal pure returns (address) {
        return uint160(a) < uint160(b) ? a : b;
    }

    function _high(address a, address b) internal pure returns (address) {
        return uint160(a) < uint160(b) ? b : a;
    }
}
