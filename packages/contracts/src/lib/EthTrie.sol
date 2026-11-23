// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SecureMerkleTrie} from "./unruggable/SecureMerkleTrie.sol";
import {RLPReader} from "./optimism/RLPReader.sol";

/// @notice Ethereum Merkle-Patricia account and storage proofs (eth_getProof).
library EthTrie {
    error AccountNotFound(address target);
    error InvalidWord();

    bytes32 constant EMPTY_STORAGE_HASH = keccak256(hex"80");

    /// @return storageRoot of `target` under `stateRoot` (reverts if the account doesn't exist)
    function getStorageRoot(bytes32 stateRoot, address target, bytes[] memory proof)
        internal
        pure
        returns (bytes32)
    {
        (bool exists, bytes memory value) = SecureMerkleTrie.get(abi.encodePacked(target), proof, stateRoot);
        if (!exists) revert AccountNotFound(target);
        // [nonce, balance, storageRoot, codeHash]
        RLPReader.RLPItem[] memory v = RLPReader.readList(value);
        return toBytes32(RLPReader.readBytes(v[2]));
    }

    /// @return value of `slot` under `storageRoot` (0 if unset)
    function getStorageValue(bytes32 storageRoot, uint256 slot, bytes[] memory proof)
        internal
        pure
        returns (bytes32)
    {
        if (storageRoot == EMPTY_STORAGE_HASH) return 0;
        (bool exists, bytes memory value) = SecureMerkleTrie.get(abi.encodePacked(slot), proof, storageRoot);
        return exists ? toBytes32(RLPReader.readBytes(value)) : bytes32(0);
    }

    /// @dev big-endian, right-aligned
    function toBytes32(bytes memory v) internal pure returns (bytes32 x) {
        if (v.length > 32) revert InvalidWord();
        assembly ("memory-safe") {
            x := shr(shl(3, sub(32, mload(v))), mload(add(v, 32)))
        }
    }
}
