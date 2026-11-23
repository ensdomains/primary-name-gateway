// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ENSIP-3 (subset)
interface INameResolver {
    function name(bytes32 node) external view returns (string memory);
}
