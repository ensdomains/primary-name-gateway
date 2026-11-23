// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

/// @notice The first field elements of an EIP-4844 blob, proven against its versioned hash, and the
///         OP Stack data they carry.
/// @dev Port of blobDataPrefix in packages/shared/src/op-batch.ts (keep them in step).
library OPBlob {
    error InvalidBlob();
    error InvalidBlobProof(uint256 index);

    uint256 constant BLS_MODULUS = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001;
    uint256 constant FIELD_ELEMENTS_PER_BLOB = 4096;
    /// @dev 7 ** ((BLS_MODULUS - 1) / 4096): a primitive 4096th root of unity (c-kzg, consensus specs)
    uint256 constant ROOT_OF_UNITY = 0x564c0a11a0f704f4fc3e8acfe0f8245f0ad1347b378fbf96e206da11a5d36306;
    address constant POINT_EVALUATION = address(0x0a);
    uint256 constant MAX_DATA = (4 * 31 + 3) * 1024 - 4;

    /// @notice Check that `fieldElements` (32 bytes each) are the first elements of the blob with
    ///         `versionedHash`: one point evaluation proof per element (the precompile checks the
    ///         commitment against the versioned hash).
    function verify(
        bytes32 versionedHash,
        bytes memory commitment,
        bytes memory fieldElements,
        bytes[] memory proofs
    ) internal view {
        uint256 n = fieldElements.length >> 5;
        if (fieldElements.length & 31 != 0 || proofs.length != n || commitment.length != 48) revert InvalidBlob();
        for (uint256 i; i < n; ++i) {
            bytes32 y;
            assembly ("memory-safe") {
                y := mload(add(add(fieldElements, 32), shl(5, i)))
            }
            (bool ok, bytes memory ret) = POINT_EVALUATION.staticcall(
                abi.encodePacked(versionedHash, _domainPoint(i), y, commitment, proofs[i])
            );
            if (!ok || ret.length != 64) revert InvalidBlobProof(i);
            (uint256 elements, uint256 modulus) = abi.decode(ret, (uint256, uint256));
            if (elements != FIELD_ELEMENTS_PER_BLOB || modulus != BLS_MODULUS) revert InvalidBlobProof(i);
        }
    }

    /// @notice The data carried by whole rounds of 4 field elements (127 bytes each round): version 0,
    ///         a 3-byte length, then the data (as much of it as the elements carry).
    function data(bytes memory fieldElements) internal pure returns (bytes memory out) {
        if (fieldElements.length & 127 != 0 || fieldElements.length == 0) revert InvalidBlob();
        uint256 rounds = fieldElements.length >> 7;
        bytes memory raw = new bytes(rounds * 127 + 1); // +1: the last 32-byte store runs one past
        assembly ("memory-safe") {
            mstore(raw, mul(rounds, 127))
        }
        for (uint256 round; round < rounds; ++round) {
            uint256 top; // top bytes of the 4 elements, byte i = element i
            assembly ("memory-safe") {
                let src := add(add(fieldElements, 32), shl(7, round))
                let dst := add(add(raw, 32), mul(round, 127))
                for { let i := 0 } lt(i, 4) { i := add(i, 1) } {
                    let w := mload(add(src, shl(5, i)))
                    top := or(top, shl(shl(3, i), byte(0, w)))
                    mstore(add(dst, shl(5, i)), shl(8, w)) // the element's 31 bytes (and a zero, set below)
                }
            }
            if (top & 0xc0c0c0c0 != 0) revert InvalidBlob();
            uint256 t0 = top & 0xff;
            uint256 t1 = (top >> 8) & 0xff;
            uint256 t2 = (top >> 16) & 0xff;
            uint256 t3 = top >> 24;
            raw[round * 127 + 31] = bytes1(uint8((t0 & 0x3f) | ((t1 & 0x30) << 2)));
            raw[round * 127 + 63] = bytes1(uint8((t1 & 0x0f) | ((t3 & 0x0f) << 4)));
            raw[round * 127 + 95] = bytes1(uint8((t2 & 0x3f) | ((t3 & 0x30) << 2)));
        }
        if (raw[0] != 0) revert InvalidBlob();
        uint256 len = (uint256(uint8(raw[1])) << 16) | (uint256(uint8(raw[2])) << 8) | uint8(raw[3]);
        if (len > MAX_DATA) revert InvalidBlob();
        if (len > raw.length - 4) len = raw.length - 4;
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 32), add(raw, 36), len)
        }
    }

    /// @dev Element i is the blob polynomial at ROOT_OF_UNITY ** bitReverse12(i).
    function _domainPoint(uint256 i) private pure returns (bytes32) {
        uint256 e;
        for (uint256 b; b < 12; ++b) {
            e |= ((i >> b) & 1) << (11 - b);
        }
        uint256 x = 1;
        uint256 base = ROOT_OF_UNITY;
        for (; e != 0; e >>= 1) {
            if (e & 1 != 0) x = mulmod(x, base, BLS_MODULUS);
            base = mulmod(base, base, BLS_MODULUS);
        }
        return bytes32(x);
    }
}
