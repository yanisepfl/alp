// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

import {ALPVault} from "../src/ALPVault.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {UniV3Adapter} from "../src/adapters/UniV3Adapter.sol";
import {UniversalRouterAdapter} from "../src/adapters/UniversalRouterAdapter.sol";
import {INonfungiblePositionManager} from "../src/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/external/ISwapRouter02.sol";
import {IUniswapV3Factory} from "../src/interfaces/external/IUniswapV3Factory.sol";
import {IUniversalRouter} from "../src/interfaces/external/IUniversalRouter.sol";

/// @notice Deploys the ALP stack to Base mainnet (chainId 8453).
///
/// Required env vars:
///   PRIVATE_KEY  deployer key
///   OWNER        vault + registry owner address
///   GUARDIAN     vault + registry guardian (pause + whitelist)
///   AGENT        hot key the agent service signs with
///
/// Pinned addresses (Base mainnet):
///   USDC                                  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///   Uniswap V3 NonfungiblePositionManager 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1
///   Uniswap V3 SwapRouter02               0x2626664c2603336E57B271c5C0b26F421741e481
///   Uniswap V3 Factory                    0x33128a8fC17869897dcE68Ed026d694621f6FDfD
///   Uniswap UniversalRouter (V4-capable)  0x6fF5693b99212Da76ad316178A184AB56D299b43
///   Permit2 (canonical)                   0x000000000022D473030F116dDEE9F6B43aC78BA3
///
/// V4 adapter is intentionally omitted from this script: hackathon scope is
/// V3 liquidity + UR-routed swaps. Add `UniV4Adapter` here once V4 pools on
/// Base mainnet have meaningful depth.
contract DeployBase is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address constant V3_NPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        address agent = vm.envAddress("AGENT");

        vm.startBroadcast(deployerKey);

        PoolRegistry registry = new PoolRegistry(owner, guardian);

        // Vault deploys before the adapters so each adapter can pin the vault
        // address as immutable (the `onlyVault` constraint).
        ALPVault vault = new ALPVault(IERC20(USDC), "ALP USDC Vault", "alpUSDC", registry, owner, agent, guardian);

        UniV3Adapter v3Adapter = new UniV3Adapter(
            INonfungiblePositionManager(V3_NPM),
            ISwapRouter02(V3_SWAP_ROUTER),
            IUniswapV3Factory(V3_FACTORY),
            address(vault)
        );

        UniversalRouterAdapter urAdapter = new UniversalRouterAdapter(
            IUniversalRouter(UNIVERSAL_ROUTER), IPermit2(PERMIT2), IUniswapV3Factory(V3_FACTORY), address(vault)
        );

        vm.stopBroadcast();

        console2.log("PoolRegistry:           ", address(registry));
        console2.log("ALPVault:               ", address(vault));
        console2.log("UniV3Adapter:           ", address(v3Adapter));
        console2.log("UniversalRouterAdapter: ", address(urAdapter));
        console2.log("");
        console2.log("Next steps for the guardian:");
        console2.log("  1. vault.bootstrapAdapter(V3_NPM, v3Adapter)");
        console2.log("  2. registry.addPool(...) for each LP pool routed via UniV3Adapter");
        console2.log("  3. registry.addPool(...) with adapter=urAdapter and enabled=false for each swap-only pair");
    }
}
