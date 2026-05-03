// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
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

/// @notice One-shot deploy of the full ALPS stack to Base mainnet (chainId 8453).
///
/// Deploys: PoolRegistry, ALPVault, UniV3Adapter, UniV4Adapter, UniversalRouterAdapter.
/// Bootstraps the V3 + V4 PositionManager operator approvals.
/// Allowlists the Alphix V4 dynamic-fee hook.
/// Registers 3 LP pool entries (USDC/cbBTC V3, USDC/USDT V3, native-ETH/USDC V4) and
///   3 matching URAdapter swap entries for the agent's swap-to-balance leg.
///
/// Required env vars:
///   PRIVATE_KEY  deployer key (also used as owner + guardian initially —
///                transfer ownership later via vault.transferOwnership +
///                vault.setGuardian if you want to split roles)
///   AGENT        hot key the agent worker will sign with (re-settable
///                later via vault.setAgent by owner)
///
/// Pinned addresses (Base mainnet):
///   USDC                                  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///   cbBTC                                 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
///   USDT                                  0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
///   Uniswap V3 NonfungiblePositionManager 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1
///   Uniswap V3 SwapRouter02               0x2626664c2603336E57B271c5C0b26F421741e481
///   Uniswap V3 Factory                    0x33128a8fC17869897dcE68Ed026d694621f6FDfD
///   Uniswap V4 PoolManager                0x498581fF718922c3f8e6A244956aF099B2652b2b
///   Uniswap V4 PositionManager            0x7C5f5A4bBd8fD63184577525326123B519429bDc
///   hookmate V4 router                    0x15c40591096E938FE2A62515A7f4B8f4349D1DEE
///   Uniswap UniversalRouter (V4-capable)  0x6fF5693b99212Da76ad316178A184AB56D299b43
///   Permit2 (canonical)                   0x000000000022D473030F116dDEE9F6B43aC78BA3
///   Alphix V4 dynamic-fee hook            0x7cBbfF9C4fcd74B221C535F4fB4B1Db04F1B9044
contract DeployBase is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant ETH_NATIVE = address(0);

    address constant V3_NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    address constant V4_POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address constant V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant V4_SWAP_ROUTER = 0x15c40591096E938FE2A62515A7f4B8f4349D1DEE;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    // Alphix V4 hooked ETH/USDC pool — dynamic-fee marker + 60 spacing matches
    // the LocalBootstrap demo. Hook address is the same on mainnet + Sepolia.
    address constant V4_HOOK = 0x7cBbfF9C4fcd74B221C535F4fB4B1Db04F1B9044;
    int24 constant V4_HOOK_TICK_SPACING = 60;
    uint24 constant V4_HOOK_FEE = 0x800000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address agent = vm.envAddress("AGENT");

        vm.startBroadcast(deployerKey);

        // 1. Deploy core. Deployer = owner = guardian initially; transfer later.
        PoolRegistry registry = new PoolRegistry(deployer, deployer);
        ALPVault vault =
            new ALPVault(IERC20(USDC), "ALPS USDC Vault", "alpUSDC", registry, deployer, agent, deployer);

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

        // 2. Allowlist the Alphix hook + bootstrap NFT operator approvals.
        registry.setHookAllowed(V4_HOOK, true);
        vault.bootstrapAdapter(V3_NPM, address(v3Adapter));
        vault.bootstrapAdapter(V4_POSITION_MANAGER, address(v4Adapter));

        // 3. Register the 3 LP entries (V4 native ETH/USDC, V3 USDC/cbBTC, V3 USDC/USDT).
        bytes32 v4EthKey = registry.addPool(
            _lpPool(address(v4Adapter), ETH_NATIVE, USDC, V4_HOOK_FEE, V4_HOOK_TICK_SPACING, V4_HOOK, 3_000)
        );
        bytes32 cbbtcKey = registry.addPool(
            _lpPool(address(v3Adapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10, address(0), 3_000)
        );
        bytes32 usdtKey = registry.addPool(
            _lpPool(address(v3Adapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1, address(0), 10_000)
        );

        // 4. Register the 3 URAdapter swap-only entries the agent uses for
        //    the swap-to-balance leg of every rebalance. enabled=true so the
        //    vault accepts them; URAdapter rejects addLiquidity at the
        //    contract layer so they can't accidentally be used as LP pools.
        bytes32 urCbbtcKey =
            registry.addPool(_swapPool(address(urAdapter), _low(USDC, CBBTC), _high(USDC, CBBTC), 500, 10));
        bytes32 urUsdtKey =
            registry.addPool(_swapPool(address(urAdapter), _low(USDC, USDT), _high(USDC, USDT), 100, 1));
        bytes32 urEthKey = registry.addPool(_swapPool(address(urAdapter), ETH_NATIVE, USDC, 500, 10));

        vm.stopBroadcast();

        // 5. Print everything the worker + frontend need.
        console2.log("");
        console2.log("# === DEPLOYED ADDRESSES ===");
        console2.log("REGISTRY   ", address(registry));
        console2.log("VAULT      ", address(vault));
        console2.log("V3_ADAPTER ", address(v3Adapter));
        console2.log("V4_ADAPTER ", address(v4Adapter));
        console2.log("UR_ADAPTER ", address(urAdapter));
        console2.log("");
        console2.log("# === POOL KEYS (LP) ===");
        console2.log("V4_ETH_USDC_KEY    ", uint256(v4EthKey));
        console2.log("V3_USDC_CBBTC_KEY  ", uint256(cbbtcKey));
        console2.log("V3_USDC_USDT_KEY   ", uint256(usdtKey));
        console2.log("");
        console2.log("# === POOL KEYS (UR swap routing) ===");
        console2.log("UR_USDC_CBBTC_KEY  ", uint256(urCbbtcKey));
        console2.log("UR_USDC_USDT_KEY   ", uint256(urUsdtKey));
        console2.log("UR_ETH_USDC_KEY    ", uint256(urEthKey));
        console2.log("");
        console2.log("# === ROLES ===");
        console2.log("owner      ", deployer, " (deployer; re-set via vault.transferOwnership)");
        console2.log("guardian   ", deployer, " (deployer; re-set via vault.setGuardian / registry.setGuardian)");
        console2.log("agent      ", agent, " (re-set via vault.setAgent)");
        console2.log("");
        console2.log("# === NEXT STEPS (off-chain) ===");
        console2.log("  1. Push the addresses above into the Worker secrets:");
        console2.log("       pnpm wrangler secret put VAULT_ADDRESS / REGISTRY_ADDRESS / V3/V4/UR_ADAPTER_ADDRESS");
        console2.log("       pnpm run deploy:worker");
        console2.log("  2. Update agent/pools.local.json with the LP+UR keys printed above.");
        console2.log("  3. Optional: deposit a small USDC seed and let the agent open positions.");
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
            hooks: hook,
            fee: fee,
            tickSpacing: spacing,
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
            hooks: address(0),
            fee: fee,
            tickSpacing: spacing,
            maxAllocationBps: 1, // sentinel: registry requires >0; vault never reads it on swap-only entries
            enabled: true
        });
    }

    function _low(address a, address b) internal pure returns (address) {
        return uint160(a) < uint160(b) ? a : b;
    }

    function _high(address a, address b) internal pure returns (address) {
        return uint160(a) < uint160(b) ? b : a;
    }
}
