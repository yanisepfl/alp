// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";
import {AddressConstants} from "hookmate/constants/AddressConstants.sol";

import {Permit2Deployer} from "hookmate/artifacts/Permit2.sol";
import {V4PoolManagerDeployer} from "hookmate/artifacts/V4PoolManager.sol";
import {V4PositionManagerDeployer} from "hookmate/artifacts/V4PositionManager.sol";
import {V4RouterDeployer} from "hookmate/artifacts/V4Router.sol";

/// @notice Deploys a complete local Uniswap V4 stack (Permit2 + PoolManager
/// + PositionManager + V4 swap router) on the foundry default chain
/// (`block.chainid == 31337`). On other chain IDs falls back to the
/// canonical hookmate-tracked addresses, allowing the same helper to drive
/// fork tests.
///
/// Adapted from openzeppelin/uniswap-hooks test pattern (and the Alphix
/// atrium repo) — kept narrow on purpose: ALP only needs the V4 stack and
/// a couple of currency helpers.
abstract contract V4Deployers is Test {
    IPermit2 internal permit2;
    IPoolManager internal poolManager;
    IPositionManager internal positionManager;
    IUniswapV4Router04 internal swapRouter;

    function deployV4Stack() internal {
        _deployPermit2();
        _deployPoolManager();
        _deployPositionManager();
        _deployRouter();
    }

    // -------- individual deployments --------

    function _deployPermit2() internal {
        address permit2Address = AddressConstants.getPermit2Address();

        if (permit2Address.code.length == 0) {
            address tempDeployAddress = address(Permit2Deployer.deploy());
            vm.etch(permit2Address, tempDeployAddress.code);
        }

        permit2 = IPermit2(permit2Address);
        vm.label(permit2Address, "Permit2");
    }

    function _deployPoolManager() internal {
        if (block.chainid == 31337) {
            poolManager = IPoolManager(address(V4PoolManagerDeployer.deploy(address(0x4444))));
        } else {
            poolManager = IPoolManager(AddressConstants.getPoolManagerAddress(block.chainid));
        }
        vm.label(address(poolManager), "V4PoolManager");
    }

    function _deployPositionManager() internal {
        if (block.chainid == 31337) {
            positionManager = IPositionManager(
                address(
                    V4PositionManagerDeployer.deploy(
                        address(poolManager), address(permit2), 300_000, address(0), address(0)
                    )
                )
            );
        } else {
            positionManager = IPositionManager(AddressConstants.getPositionManagerAddress(block.chainid));
        }
        vm.label(address(positionManager), "V4PositionManager");
    }

    function _deployRouter() internal {
        if (block.chainid == 31337) {
            swapRouter = IUniswapV4Router04(payable(V4RouterDeployer.deploy(address(poolManager), address(permit2))));
        } else {
            swapRouter = IUniswapV4Router04(payable(AddressConstants.getV4SwapRouterAddress(block.chainid)));
        }
        vm.label(address(swapRouter), "V4SwapRouter");
    }
}
