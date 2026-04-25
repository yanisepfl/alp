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
import {INonfungiblePositionManager} from "../src/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/external/ISwapRouter02.sol";
import {IUniswapV3Factory} from "../src/interfaces/external/IUniswapV3Factory.sol";

/// @notice Deploys the ALP stack to Base Sepolia (chainId 84532).
///
/// Required env vars:
///   PRIVATE_KEY            deployer key
///   BASE_ASSET             base ERC20 (default: a Sepolia USDC mock — TBD)
///   OWNER                  vault + registry owner address
///   GUARDIAN               vault + registry guardian (pause + whitelist)
///   AGENT                  hot key the agent service signs with
///   V4_SWAP_ROUTER         hookmate V4 router address (chain-specific)
///
/// Pinned addresses (Base Sepolia, chainId 84532):
///   Uniswap V3 NonfungiblePositionManager  0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2
///   Uniswap V3 SwapRouter02                0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4
///   Uniswap V4 PoolManager                 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408
///   Uniswap V4 PositionManager             0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80
///   Uniswap V4 UniversalRouter             0x492e6456d9528771018deb9e87ef7750ef184104
///   Permit2 (canonical)                    0x000000000022D473030F116dDEE9F6B43aC78BA3
contract Deploy is Script {
    address constant V3_NPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address constant V3_SWAP_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant V3_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant V4_POSITION_MANAGER = 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80;
    address constant V4_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address baseAsset = vm.envAddress("BASE_ASSET");
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        address agent = vm.envAddress("AGENT");
        address v4SwapRouter = vm.envAddress("V4_SWAP_ROUTER");

        vm.startBroadcast(deployerKey);

        PoolRegistry registry = new PoolRegistry(owner, guardian);

        UniV3Adapter v3Adapter = new UniV3Adapter(
            INonfungiblePositionManager(V3_NPM), ISwapRouter02(V3_SWAP_ROUTER), IUniswapV3Factory(V3_FACTORY)
        );

        UniV4Adapter v4Adapter = new UniV4Adapter(
            IPositionManager(V4_POSITION_MANAGER),
            IPoolManager(V4_POOL_MANAGER),
            IUniswapV4Router04(payable(v4SwapRouter)),
            IPermit2(PERMIT2)
        );

        ALPVault vault = new ALPVault(IERC20(baseAsset), "ALP USDC Vault", "alpUSDC", registry, owner, agent, guardian);

        vm.stopBroadcast();

        console2.log("PoolRegistry:", address(registry));
        console2.log("UniV3Adapter:", address(v3Adapter));
        console2.log("UniV4Adapter:", address(v4Adapter));
        console2.log("ALPVault:    ", address(vault));
        console2.log("");
        console2.log("Next: guardian must call vault.bootstrapAdapter for both managers:");
        console2.log("  vault.bootstrapAdapter(V3_NPM=%s, v3Adapter=%s)", V3_NPM, address(v3Adapter));
        console2.log("  vault.bootstrapAdapter(V4_POSM=%s, v4Adapter=%s)", V4_POSITION_MANAGER, address(v4Adapter));
    }
}
