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
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ILiquidityAdapter} from "../src/interfaces/ILiquidityAdapter.sol";
import {INonfungiblePositionManager} from "../src/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/external/ISwapRouter02.sol";
import {IUniswapV3Factory} from "../src/interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../src/interfaces/external/IUniswapV3Pool.sol";
import {IUniversalRouter} from "../src/interfaces/external/IUniversalRouter.sol";

/// @notice One-shot bootstrap of the ALP stack against an Anvil fork of Base
/// mainnet. Deploys all contracts, registers a V4 hooked native-ETH/USDC
/// pool plus V3 USDC/cbBTC and V3 USDC/USDT LP pools and three URAdapter
/// swap entries. Seeds three demo positions:
///   (a) cbBTC out-of-range above current tick — single-sided USDC, designed
///       to exercise the agent's swap-then-add rebalance path.
///   (b) USDT in-range — wide ±50 ticks, the "well-behaved" counterpart.
///   (c) V4 native-ETH/USDC — proves the V4 native-ETH plumbing end-to-end
///       (vault holds native ETH, msg.value forwarded through the adapter
///       to V4's SETTLE).
///
/// The script does NOT fund USDC itself — `scripts/local-fork.sh` pre-funds
/// the deployer via anvil storage manipulation before running the script.
/// The deployer then `vault.deposit`s the USDC inside this script, after
/// which the agent (anvil account 1) opens the positions.
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

    // V4 hooked ETH/USDC pool. fee = DYNAMIC_FEE_FLAG (0x800000) tells the
    // V4 PoolManager that the hook supplies LP fees per swap; the static
    // initial value (499 = 0.0499%) sits inside the hook, not the PoolKey.
    address constant V4_HOOK = 0x7cBbfF9C4fcd74B221C535F4fB4B1Db04F1B9044;
    int24 constant V4_HOOK_TICK_SPACING = 60;
    uint24 constant V4_HOOK_FEE = 0x800000;

    // Anvil default funded accounts
    address constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant AGENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 constant AGENT_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    // Seed amount (10k USDC)
    uint256 constant SEED_USDC = 10_000e6;

    // Storage slots for bootstrap output. Putting these here (rather than
    // stack locals in run()) keeps the function within via_ir's stack
    // budget — the script needs ~12 contract refs / pool keys live at once
    // for printing the env block, which exceeds the 16-slot Yul ceiling
    // when also building V4 PoolKey structs inline.
    PoolRegistry internal sRegistry;
    ALPVault internal sVault;
    UniV3Adapter internal sV3Adapter;
    UniV4Adapter internal sV4Adapter;
    UniversalRouterAdapter internal sUrAdapter;
    bytes32 internal sV4HookKey;
    bytes32 internal sCbbtcKey;
    bytes32 internal sUsdtKey;
    bytes32 internal sUrWethKey;
    bytes32 internal sUrEthKey;
    bytes32 internal sUrCbbtcKey;
    bytes32 internal sUrUsdtKey;

    function run() external {
        _phase1Deploy();
        _phase2Seed();
        _phase3Print();
    }

    function _phase1Deploy() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        sRegistry = new PoolRegistry(DEPLOYER, DEPLOYER);
        sVault = new ALPVault(IERC20(USDC), "ALP USDC Vault", "alpUSDC", sRegistry, DEPLOYER, AGENT, DEPLOYER);
        sV3Adapter = new UniV3Adapter(
            INonfungiblePositionManager(V3_NPM),
            ISwapRouter02(V3_SWAP_ROUTER),
            IUniswapV3Factory(V3_FACTORY),
            address(sVault)
        );
        sV4Adapter = new UniV4Adapter(
            IPositionManager(V4_POSITION_MANAGER),
            IPoolManager(V4_POOL_MANAGER),
            IUniswapV4Router04(payable(V4_SWAP_ROUTER)),
            IPermit2(PERMIT2),
            address(sVault)
        );
        sUrAdapter = new UniversalRouterAdapter(
            IUniversalRouter(UNIVERSAL_ROUTER), IPermit2(PERMIT2), IUniswapV3Factory(V3_FACTORY), address(sVault)
        );

        sRegistry.setHookAllowed(V4_HOOK, true);
        sVault.bootstrapAdapter(V3_NPM, address(sV3Adapter));
        sVault.bootstrapAdapter(V4_POSITION_MANAGER, address(sV4Adapter));

        // LP entries. Allocation caps: 30% volatile / 100% stable, modelled
        // loosely on JLP/GLP composition.
        sV4HookKey = sRegistry.addPool(
            _lpPool(address(sV4Adapter), ETH_NATIVE, USDC, V4_HOOK_FEE, V4_HOOK_TICK_SPACING, V4_HOOK, 3_000)
        );
        sCbbtcKey = sRegistry.addPool(
            _lpPool(address(sV3Adapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10, address(0), 3_000)
        );
        sUsdtKey = sRegistry.addPool(
            _lpPool(address(sV3Adapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1, address(0), 10_000)
        );

        // URAdapter swap-only entries. Two ETH↔USDC entries — WETH for V3,
        // native ETH for V4.
        sUrWethKey = sRegistry.addPool(_swapPool(address(sUrAdapter), _low(USDC, WETH), _high(USDC, WETH), 500, 10));
        sUrEthKey = sRegistry.addPool(_swapPool(address(sUrAdapter), ETH_NATIVE, USDC, 500, 10));
        sUrCbbtcKey = sRegistry.addPool(_swapPool(address(sUrAdapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10));
        sUrUsdtKey = sRegistry.addPool(_swapPool(address(sUrAdapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1));

        // Per-tx swap cap = 50% of TAV. Worst case: full unwind of the
        // 100%-capped USDT pool needs ~50% swap; volatile (30% cap) at most
        // ~15%.
        sVault.setSwapNotionalCapBps(5_000);

        // Deployer deposits USDC + tops up vault with native ETH for V4 seed.
        IERC20(USDC).approve(address(sVault), SEED_USDC);
        sVault.deposit(SEED_USDC, DEPLOYER);
        (bool ok,) = address(sVault).call{value: 0.5 ether}("");
        require(ok, "vault ETH funding failed");
        vm.stopBroadcast();
    }

    function _phase2Seed() internal {
        vm.startBroadcast(AGENT_KEY);
        _seedCbbtc(sVault, sCbbtcKey);
        _seedUsdt(sVault, sUsdtKey);
        _seedV4(sVault, sV4Adapter, sV4HookKey);
        vm.stopBroadcast();
    }

    function _phase3Print() internal view {
        console2.log("");
        console2.log("# === AGENT_ENV (paste into agent/.env) ===");
        console2.log("BASE_RPC_URL=http://localhost:8545");
        console2.log("VAULT_ADDRESS=", address(sVault));
        console2.log("REGISTRY_ADDRESS=", address(sRegistry));
        console2.log("V3_ADAPTER_ADDRESS=", address(sV3Adapter));
        console2.log("V4_ADAPTER_ADDRESS=", address(sV4Adapter));
        console2.log("UR_ADAPTER_ADDRESS=", address(sUrAdapter));
        console2.log("AGENT_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        console2.log("");
        console2.log("# Pool keys");
        console2.log("V4_ETH_USDC_KEY=", uint256(sV4HookKey));
        console2.log("V3_USDC_CBBTC_KEY=  ", uint256(sCbbtcKey));
        console2.log("V3_USDC_USDT_KEY=   ", uint256(sUsdtKey));
        console2.log("UR_USDC_WETH_KEY=   ", uint256(sUrWethKey));
        console2.log("UR_ETH_USDC_KEY=    ", uint256(sUrEthKey));
        console2.log("UR_USDC_CBBTC_KEY=  ", uint256(sUrCbbtcKey));
        console2.log("UR_USDC_USDT_KEY=   ", uint256(sUrUsdtKey));
        console2.log("");
        console2.log("# Vault state");
        console2.log("vault USDC balance:", IERC20(USDC).balanceOf(address(sVault)));
        console2.log("vault CBBTC balance:", IERC20(CBBTC).balanceOf(address(sVault)));
    }

    /// @dev cbBTC seed: out-of-range above current tick (single-sided USDC).
    /// 2k USDC is 20% of the $10k vault, comfortably under the pool's 30% cap.
    function _seedCbbtc(ALPVault vault, bytes32 cbbtcKey) internal {
        int24 tick = _currentTick(USDC, CBBTC, 500);
        int24 lower = _alignUp(tick + 500, 10);
        int24 upper = lower + 500;
        bool usdcIsT0 = USDC == _low(USDC, CBBTC);
        vault.executeAddLiquidity(
            cbbtcKey,
            usdcIsT0 ? 2_000e6 : 0,
            usdcIsT0 ? 0 : 2_000e6,
            0,
            0,
            abi.encode(lower, upper, block.timestamp + 600, uint256(0))
        );
    }

    /// @dev USDT seed: in-range ±50 ticks (wider than the agent's planned
    /// ±2). Swaps 2.5k USDC → USDT first so the LP add has both legs.
    function _seedUsdt(ALPVault vault, bytes32 usdtKey) internal {
        vault.executeSwap(usdtKey, USDC, 2_500e6, 1, abi.encode(block.timestamp + 600));
        int24 tick = _currentTick(USDC, USDT, 100);
        int24 lower = _alignDown(tick - 50, 1);
        int24 upper = _alignUp(tick + 50, 1);
        uint256 bUsdc = IERC20(USDC).balanceOf(address(vault));
        uint256 bUsdt = IERC20(USDT).balanceOf(address(vault));
        bool usdcIsT0 = USDC == _low(USDC, USDT);
        vault.executeAddLiquidity(
            usdtKey,
            usdcIsT0 ? bUsdc : bUsdt,
            usdcIsT0 ? bUsdt : bUsdc,
            0,
            0,
            abi.encode(lower, upper, block.timestamp + 600, uint256(0))
        );
    }

    function _seedV4(ALPVault vault, UniV4Adapter v4Adapter, bytes32 v4HookKey) internal {
        // ±~6% band around current spot (10 spacings of 60), in-range for
        // normal market conditions. Sized at 0.5 ETH ≈ $1.7k so the resulting
        // V4 position fits under the pool's 30% allocation cap on a $10k vault.
        uint160 sqrtPrice = ILiquidityAdapter(address(v4Adapter))
            .getSpotSqrtPriceX96(
                PoolRegistry.Pool({
                    adapter: address(v4Adapter),
                    token0: ETH_NATIVE,
                    token1: USDC,
                    hooks: V4_HOOK,
                    fee: V4_HOOK_FEE,
                    tickSpacing: V4_HOOK_TICK_SPACING,
                    maxAllocationBps: 3_000,
                    enabled: true
                })
            );
        int24 tick = _tickFromSqrtPriceX96(sqrtPrice);
        int24 lower = _alignDown(tick - 600, V4_HOOK_TICK_SPACING);
        int24 upper = _alignUp(tick + 600, V4_HOOK_TICK_SPACING);
        uint256 ethAmount = 0.5 ether;
        // USDC side scaled to roughly match ETH value at ~$3500/ETH so the
        // V4 mint absorbs both sides cleanly at this band.
        uint256 usdcAmount = (ethAmount * 3500e6) / 1e18;
        vault.executeAddLiquidity(
            v4HookKey, ethAmount, usdcAmount, 0, 0, abi.encode(lower, upper, block.timestamp + 600, uint256(0))
        );
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

    function _tickFromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (int24) {
        return TickMath.getTickAtSqrtPrice(sqrtPriceX96);
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
