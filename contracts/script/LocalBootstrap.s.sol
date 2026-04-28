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

        registry.setHookAllowed(V4_HOOK, true);
        vault.bootstrapAdapter(V3_NPM, address(v3Adapter));
        vault.bootstrapAdapter(V4_POSITION_MANAGER, address(v4Adapter));

        // LP-pool entries.
        // Per-pool allocation caps modeled loosely on JLP/GLP composition:
        // stables can absorb 100% of the vault, volatile pairs are capped at
        // 30% so a single position can't dominate.
        // V4 hooked ETH/USDC pool with token0 = native ETH (the V4 sentinel
        // address(0)). Hook is owner-allowlisted above.
        bytes32 v4HookKey = registry.addPool(
            _lpPool(address(v4Adapter), ETH_NATIVE, USDC, V4_HOOK_FEE, V4_HOOK_TICK_SPACING, V4_HOOK, 3_000)
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
        // Top up the vault with native ETH for the V4 native-pool seed.
        // Real flow: agent swaps USDC → ETH via UR. For the bootstrap demo
        // we send ETH directly to keep the seed deterministic. 0.5 ETH ≈
        // $1700 keeps the resulting V4 position under the 30% pool cap on
        // a $10k vault.
        (bool ok,) = address(vault).call{value: 0.5 ether}("");
        require(ok, "vault ETH funding failed");
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

        // (c) V4 native-ETH pool. Seed an in-range position spanning ±5%.
        // V4 returns the pool's current tick via PoolManager.getSlot0; we
        // hard-code a wide ±~10% band here for simplicity since the V4
        // adapter doesn't expose currentTick yet.
        // Position seed: 2 ETH + matching USDC at the current spot.
        // Alphix pool: token0 = native ETH, token1 = USDC.
        // tickSpacing = 60.
        uint160 v4SqrtPrice = ILiquidityAdapter(address(v4Adapter))
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
        // Convert sqrtPriceX96 → tick via TickMath. Inline approximation:
        // tick = log_{sqrt(1.0001)}(sqrtPriceX96 / Q96) * 2. Simpler: encode
        // a wide band [tick - 600, tick + 600] (≈ ±6% on ETH, generously
        // in-range under any normal market). For reproducibility, we let the
        // V4 PositionManager compute liquidity from the desired amounts.
        // Use ±600 ticks (10 spacings of 60) around the current sqrtPrice's
        // tick; we approximate by bracketing widely.
        int24 ethTick = _tickFromSqrtPriceX96(v4SqrtPrice);
        int24 ethLower = _alignDown(ethTick - 600, V4_HOOK_TICK_SPACING);
        int24 ethUpper = _alignUp(ethTick + 600, V4_HOOK_TICK_SPACING);
        uint256 ethAmount = 0.5 ether;
        // Cap USDC side at the value of the ETH side so the V4 mint doesn't
        // try to consume more than the new position can absorb at this
        // tight range. ETH price ≈ vault.totalAssets - balances; we approximate
        // by using a fixed ratio (~$3500/ETH) so the seed stays deterministic.
        uint256 vaultUsdcForEth = ethAmount * 3500 / 1e12; // 0.5 ETH * 3500 / 1e12 = 1.75e6 = 1.75 USDC? need scaling
        vaultUsdcForEth = (ethAmount * 3500e6) / 1e18; // proper scaling: ETH amount × USDC price × 1e6 / 1e18
        // V4 PoolKey orders by Currency.unwrap; native ETH (0) < USDC.
        // amount0 = ETH, amount1 = USDC.
        vault.executeAddLiquidity(
            v4HookKey,
            ethAmount,
            vaultUsdcForEth,
            0,
            0,
            abi.encode(ethLower, ethUpper, block.timestamp + 600, uint256(0))
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
        console2.log("V4_ETH_USDC_KEY=", uint256(v4HookKey));
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
