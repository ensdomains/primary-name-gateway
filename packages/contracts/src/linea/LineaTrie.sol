// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Poseidon2} from "../lib/linea/Poseidon2.sol";

/// @notice Linea (Shomei) sparse Merkle trie multiproofs.
/// @dev The same trie is used for the world state (accounts) and contract storage:
///      - binary tree of depth 40, leaves in insertion order, linked in `hKey` order
///        between the HEAD (#0) and TAIL (#1) sentinels
///      - root = H(pad(nextFreeIndex) . subRoot)
///      - leaf = pad(prev) . pad(next) . hKey . hValue (192 bytes)
///      Unlike `linea_getProof` (one path per key, sibling preimages), a `MultiProof` carries
///      sibling hashes and shares the path nodes of its leaves: Poseidon2 costs ~50k gas per
///      32-byte block, so every hash matters.
///      Reference (AGPL, not copied): LFDT-Lineth/lineth-monorepo contracts/src/libraries/SparseMerkleProof.sol
library LineaTrie {
    error InvalidProof();

    uint256 constant DEPTH = 40;
    uint256 constant LEAF_SIZE = 192;
    uint256 constant ACCOUNT_SIZE = 192;
    uint32 constant KOALABEAR_PRIME = 2130706433;

    struct MultiProof {
        bytes top; // pad(nextFreeIndex) . subRoot (96 bytes)
        uint256[] indices; // leaf indices, strictly ascending
        bytes[] leaves; // 192-byte leaves
        bytes[] values; // raw value of each leaf (empty when the leaf only bounds an exclusion)
        bytes32[] siblings; // sibling hashes, in the order verifyLeaves() consumes them
    }

    /// @dev Verify that the leaves of `p` are in the trie with root `root`.
    function verifyLeaves(bytes32 root, MultiProof memory p) internal pure {
        uint256 k = p.indices.length;
        if (k == 0 || p.leaves.length != k || p.values.length != k || p.top.length != 96) revert InvalidProof();
        uint256[] memory idx = new uint256[](k);
        bytes32[] memory h = new bytes32[](k);
        for (uint256 i; i < k; ++i) {
            uint256 index = p.indices[i];
            if (index >> DEPTH != 0 || (i > 0 && index <= p.indices[i - 1])) revert InvalidProof();
            if (p.leaves[i].length != LEAF_SIZE) revert InvalidProof();
            idx[i] = index;
            h[i] = Poseidon2.hash(p.leaves[i]);
        }
        uint256 s;
        for (uint256 level; level < DEPTH; ++level) {
            uint256 n;
            for (uint256 i; i < k; ++n) {
                uint256 index = idx[i];
                bytes32 parent;
                if (index & 1 == 0 && i + 1 < k && idx[i + 1] == index + 1) {
                    parent = _hash2(h[i], h[i + 1]);
                    i += 2;
                } else {
                    if (s == p.siblings.length) revert InvalidProof();
                    bytes32 sibling = p.siblings[s++];
                    parent = index & 1 == 0 ? _hash2(h[i], sibling) : _hash2(sibling, h[i]);
                    i += 1;
                }
                idx[n] = index >> 1;
                h[n] = parent;
            }
            k = n;
        }
        if (s != p.siblings.length || h[0] != _word(p.top, 2) || Poseidon2.hash(p.top) != root) revert InvalidProof();
    }

    /// @dev Position of the leaf with `hKey` in `p` (`found`), or not found if two adjacent leaves bracket it.
    ///      Reverts if the leaves of `p` (verified by verifyLeaves()) prove neither.
    ///      The caller checks the found leaf's hValue against its value.
    function find(MultiProof memory p, bytes32 hKey) internal pure returns (bool found, uint256 pos) {
        uint256 k = p.indices.length;
        for (uint256 i; i < k; ++i) {
            if (_word(p.leaves[i], 4) == hKey) return (true, i);
        }
        // exclusion: a.next == b, b.prev == a, a.hKey < hKey < b.hKey
        for (uint256 i; i < k; ++i) {
            bytes memory a = p.leaves[i];
            bytes32 ka = _word(a, 4);
            if (ka >= hKey) continue;
            uint256 next = _unpadIndex(_word(a, 2), _word(a, 3));
            for (uint256 j; j < k; ++j) {
                if (p.indices[j] != next) continue;
                bytes memory b = p.leaves[j];
                bytes32 kb = _word(b, 4);
                // hash inputs are reduced mod p, so a leaf hash doesn't pin down its hKey bytes:
                // require canonical limbs so the order check can't use an alias
                if (
                    hKey < kb && _unpadIndex(_word(b, 0), _word(b, 1)) == p.indices[i] && _isCanonical(ka)
                        && _isCanonical(kb)
                ) {
                    return (false, 0);
                }
            }
        }
        revert InvalidProof();
    }

    /// @dev Key of a storage slot (also the value hash of a storage word).
    function hashWord(bytes32 x) internal pure returns (bytes32) {
        return Poseidon2.hash(Poseidon2.padBytes32(x));
    }

    /// @dev Key of an account: the left-aligned address, padded, without its trailing zero limbs.
    function hashAccountKey(address target) internal pure returns (bytes32) {
        bytes memory padded = Poseidon2.padBytes32(bytes32(bytes20(target)));
        return Poseidon2.hash(abi.encodePacked(_word(padded, 0), _word(padded, 1) >> 192));
    }

    /// @dev account = nonce . balance . storageRoot . snarkCodeHash . keccakCodeHash . codeSize (6 words)
    function hashAccountValue(bytes memory account) internal pure returns (bytes32) {
        if (account.length != ACCOUNT_SIZE) revert InvalidProof();
        return Poseidon2.hash(
            abi.encodePacked(
                Poseidon2.padBytes32(_word(account, 0)),
                Poseidon2.padBytes32(_word(account, 1)),
                _word(account, 2),
                _word(account, 3),
                Poseidon2.padBytes32(_word(account, 4)),
                Poseidon2.padBytes32(_word(account, 5))
            )
        );
    }

    function hValueOf(MultiProof memory p, uint256 pos) internal pure returns (bytes32) {
        return _word(p.leaves[pos], 5);
    }

    function storageRootOf(bytes memory account) internal pure returns (bytes32) {
        return _word(account, 2);
    }

    function _hash2(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return Poseidon2.hash(abi.encodePacked(a, b));
    }

    /// @dev inverse of padBytes32 for a leaf index (< 2^40): the low 4 limbs of the second word hold 2 bytes each
    function _unpadIndex(bytes32 hi, bytes32 lo) private pure returns (uint256 x) {
        if (hi != 0) return type(uint256).max;
        uint256 v = uint256(lo);
        for (uint256 i; i < 8; ++i) {
            uint256 limb = (v >> (i << 5)) & 0xffffffff;
            if (limb > 0xffff) return type(uint256).max;
            x |= limb << (i << 4);
        }
    }

    /// @dev every 32-bit limb < p
    function _isCanonical(bytes32 x) private pure returns (bool) {
        uint256 v = uint256(x);
        for (uint256 i; i < 8; ++i) {
            if (uint32(v >> (i << 5)) >= KOALABEAR_PRIME) return false;
        }
        return true;
    }

    function _word(bytes memory v, uint256 i) private pure returns (bytes32 x) {
        if (v.length < (i + 1) << 5) revert InvalidProof();
        assembly ("memory-safe") {
            x := mload(add(add(v, 32), shl(5, i)))
        }
    }
}
