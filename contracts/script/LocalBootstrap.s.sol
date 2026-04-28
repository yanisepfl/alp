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
import {IUniswapV3Pool} from "../src/interfaces/external/IUniswapV3Pool.sol";
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

        // LP-pool entries.
        // Per-pool allocation caps modeled loosely on JLP/GLP composition:
        // stables can absorb 100% of the vault, volatile pairs are capped at
        // 30% so a single position can't dominate.
        // Alphix V4 ETH/USDC pool (hook allowlisted above; uses native ETH
        // as token0). Registry accepts it; opening positions there requires
        // the V4 adapter's native-ETH path (separate work item).
        bytes32 alphixKey = registry.addPool(
            _lpPool(address(v4Adapter), ETH_NATIVE, USDC, ALPHIX_FEE, ALPHIX_TICK_SPACING, ALPHIX_HOOK, 3_000)
        );
        bytes32 cbbtcKey = registry.addPool(
            _lpPool(address(v3Adapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10, address(0), 3_000)
        );
        bytes32 usdtKey = registry.addPool(
            _lpPool(address(v3Adapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1, address(0), 10_000)
        );

        // URAdapter swap-only entries (one per pair we expect to swap)
        bytes32 urEthKey = registry.addPool(_swapPool(address(urAdapter), _low(USDC, WETH), _high(USDC, WETH), 500, 10));
        bytes32 urCbbtcKey =
            registry.addPool(_swapPool(address(urAdapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10));
        bytes32 urUsdtKey = registry.addPool(_swapPool(address(urAdapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1));

        // -------- Phase 2: deployer deposits USDC into the vault --------
        // The shell wrapper pre-funded DEPLOYER with USDC via anvil storage
        // manipulation. Now DEPLOYER approves and deposits — vault holds the
        // USDC and DEPLOYER holds shares.
        IERC20(USDC).approve(address(vault), SEED_USDC);
        vault.deposit(SEED_USDC, DEPLOYER);
        vm.stopBroadcast();

        // -------- Phase 3: agent seeds two demo positions --------
        // a) cbBTC OUT-OF-RANGE above current tick → single-sided USDC.
        //    After remove the vault gets back all USDC, forcing the executor
        //    to swap half → cbBTC via the URAdapter (= Trading API call) on
        //    the next rebalance. Designed to exercise the full loop.
        // b) USDT IN-RANGE around current spot, ±50 ticks initial seed (wider
        //    than the agent's planned ±2). Agent will hold this on every
        //    tick until USDT actually depegs — useful as the "well-behaved"
        //    counterexample alongside (a).
        vm.startBroadcast(AGENT_KEY);

        // (a) cbBTC out-of-range above
        int24 cbbtcTick = _currentTick(USDC, CBBTC, 500);
        // 500 ticks above current, 500 wide. Always strictly above current
        // tick → V3 mint takes only USDC (token0) for this position.
        int24 cbbtcLower = _alignUp(cbbtcTick + 500, 10);
        int24 cbbtcUpper = cbbtcLower + 500;
        // Seed size = 2k USDC. With a 10k vault that's 20% — fits under the
        // pool's 30% allocation cap, and after a forced rebalance the new
        // in-range position will be roughly the same size.
        bool usdcIsT0Cbbtc = USDC == _low(USDC, CBBTC);
        uint256 cbbtcAdd0 = usdcIsT0Cbbtc ? 2_000e6 : 0;
        uint256 cbbtcAdd1 = usdcIsT0Cbbtc ? 0 : 2_000e6;
        vault.executeAddLiquidity(
            cbbtcKey, cbbtcAdd0, cbbtcAdd1, 0, 0, abi.encode(cbbtcLower, cbbtcUpper, block.timestamp + 600, uint256(0))
        );

        // (b) USDT in-range. Need both legs, so swap a small amount of USDC
        //     to USDT first via the V3 0.01% pool.
        vault.executeSwap(usdtKey, USDC, 2_500e6, 1, "");
        int24 usdtTick = _currentTick(USDC, USDT, 100);
        int24 usdtLower = _alignDown(usdtTick - 50, 1);
        int24 usdtUpper = _alignUp(usdtTick + 50, 1);
        uint256 vaultUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultUsdt = IERC20(USDT).balanceOf(address(vault));
        bool usdcIsT0Usdt = USDC == _low(USDC, USDT);
        uint256 usdtAdd0 = usdcIsT0Usdt ? vaultUsdc : vaultUsdt;
        uint256 usdtAdd1 = usdcIsT0Usdt ? vaultUsdt : vaultUsdc;
        vault.executeAddLiquidity(
            usdtKey, usdtAdd0, usdtAdd1, 0, 0, abi.encode(usdtLower, usdtUpper, block.timestamp + 600, uint256(0))
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
        console2.log("ALPHIX_V4_ETH_USDC_KEY=", uint256(alphixKey));
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

    function _lpPool(address adapter, address t0, address t1, uint24 fee, int24 spacing, address hook, uint16 maxBps)
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
            maxAllocationBps: maxBps,
            enabled: true
        });
    }

    function _swapPool(address adapter, address t0, address t1, uint24 fee, int24 spacing)
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
            hooks: address(0),
            // Min legal value; URAdapter pools never participate in LP allocation.
            maxAllocationBps: 1,
            enabled: false
        });
    }

    function _currentTick(address tokenA, address tokenB, uint24 fee) internal view returns (int24 tick) {
        address poolAddr = IUniswapV3Factory(V3_FACTORY).getPool(tokenA, tokenB, fee);
        require(poolAddr != address(0), "no V3 pool");
        (, tick,,,,,) = IUniswapV3Pool(poolAddr).slot0();
    }

    function _alignUp(int24 v, int24 spacing) internal pure returns (int24) {
        int24 mod = v % spacing;
        if (mod == 0) return v;
        return v > 0 ? v + (spacing - mod) : v - mod;
    }

    function _alignDown(int24 v, int24 spacing) internal pure returns (int24) {
        int24 mod = v % spacing;
        if (mod == 0) return v;
        return v > 0 ? v - mod : v - (spacing + mod);
    }

    function _low(address a, address b) internal pure returns (address) {
        return uint160(a) < uint160(b) ? a : b;
    }

    function _high(address a, address b) internal pure returns (address) {
        return uint160(a) < uint160(b) ? b : a;
    }
}
