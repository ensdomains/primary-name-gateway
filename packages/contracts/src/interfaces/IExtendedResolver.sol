// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ENSIP-10
interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @notice ENSIP-3 (subset)
interface INameResolver {
    function name(bytes32 node) external view returns (string memory);
}
