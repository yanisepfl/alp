// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Subset of Uniswap's Universal Router interface used by ALPS.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}
