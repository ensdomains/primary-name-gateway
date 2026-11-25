// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

/// @notice The first field elements of an EIP-4844 blob, proven against its versioned hash, and the
///         OP Stack data they carry.
/// @dev Port of blobDataPrefix in packages/shared/src/op-batch.ts (keep them in step); the proof is
///      KZG.proveFieldElements in packages/registrar-indexer/src/kzg.ts.
library OPBlob {
    error InvalidBlob();
    error InvalidBlobProof();

    uint256 constant BLS_MODULUS = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001;
    uint256 constant FIELD_ELEMENTS_PER_BLOB = 4096;
    /// @dev 7 ** ((BLS_MODULUS - 1) / 4096): a primitive 4096th root of unity (c-kzg, consensus specs)
    uint256 constant ROOT_OF_UNITY = 0x564c0a11a0f704f4fc3e8acfe0f8245f0ad1347b378fbf96e206da11a5d36306;
    address constant POINT_EVALUATION = address(0x0a);
    address constant MODEXP = address(0x05);
    uint256 constant MAX_DATA = (4 * 31 + 3) * 1024 - 4;
    /// @dev the commitment to q (48 bytes), p(z) (32), and the openings of p and q at z (48 each)
    uint256 constant PROOF_BYTES = 176;

    /// @notice Check that `fieldElements` (32 bytes each, a power of two of them) are the first elements
    ///         of the blob with `versionedHash`, with two point evaluation calls whatever their number.
    /// @dev Element i is the blob polynomial p at ROOT_OF_UNITY ** bitReverse12(i), so the first n
    ///      (n = 2^m) are p at the n-th roots of unity x_j, element bitReverse_m(j) at x_j = w^j. Let I
    ///      interpolate them. The prover commits to q = (p - I) / (X^n - 1), which is a polynomial only
    ///      if the elements are p's. At z = hash(everything chosen), p(z) = I(z) + q(z) (z^n - 1) then
    ///      holds for wrong elements with probability about 8192 / BLS_MODULUS. `proof` gives p(z); q(z)
    ///      follows from it, and both openings are checked (the precompile checks a commitment against
    ///      the versioned hash it's given, so q's is computed here).
    function verify(bytes32 versionedHash, bytes memory commitment, bytes memory fieldElements, bytes memory proof)
        internal
        view
    {
        uint256 n = fieldElements.length >> 5;
        if (
            fieldElements.length & 31 != 0 || n == 0 || n > FIELD_ELEMENTS_PER_BLOB || n & (n - 1) != 0
                || commitment.length != 48 || proof.length != PROOF_BYTES
        ) revert InvalidBlob();
        bytes memory quotient = new bytes(48);
        uint256 y;
        assembly ("memory-safe") {
            mcopy(add(quotient, 32), add(proof, 32), 48)
            y := mload(add(proof, 80))
        }
        uint256 z =
            uint256(keccak256(abi.encodePacked(versionedHash, commitment, quotient, fieldElements))) % BLS_MODULUS;
        uint256 qz = _quotientAt(fieldElements, n, z, y);
        _open(versionedHash, z, y, commitment, proof, 80);
        bytes32 h = sha256(quotient);
        _open((h & ~bytes32(uint256(0xff) << 248)) | bytes32(uint256(1) << 248), z, qz, quotient, proof, 128);
    }

    /// @dev q(z) = (p(z) - I(z)) / (z^n - 1), with I(z) = (z^n - 1) / n * sum_j e_j x_j / (z - x_j)
    ///      (barycentric, over the n-th roots of unity), summed as a fraction a / b: one inversion.
    function _quotientAt(bytes memory fieldElements, uint256 n, uint256 z, uint256 y) private view returns (uint256) {
        uint256 w = ROOT_OF_UNITY;
        uint256 bits = 12;
        for (; (1 << bits) > n; --bits) {
            w = mulmod(w, w, BLS_MODULUS);
        }
        uint256 a;
        uint256 b = 1;
        uint256 x = 1;
        uint256 i; // bitReverse_bits(j): element i is p at x = w^j
        for (uint256 j; j < n; ++j) {
            uint256 e;
            assembly ("memory-safe") {
                e := mload(add(add(fieldElements, 32), shl(5, i)))
            }
            if (e >= BLS_MODULUS) revert InvalidBlob();
            uint256 d = addmod(z, BLS_MODULUS - x, BLS_MODULUS);
            a = addmod(mulmod(a, d, BLS_MODULUS), mulmod(mulmod(e, x, BLS_MODULUS), b, BLS_MODULUS), BLS_MODULUS);
            b = mulmod(b, d, BLS_MODULUS);
            x = mulmod(x, w, BLS_MODULUS);
            unchecked {
                // increment the bit reversal: add 1 at the top bit, carrying down
                uint256 bit = n >> 1;
                for (; i & bit != 0; bit >>= 1) {
                    i ^= bit;
                }
                i |= bit;
            }
        }
        uint256 zn = z;
        for (uint256 k; k < bits; ++k) {
            zn = mulmod(zn, zn, BLS_MODULUS);
        }
        uint256 vanishing = addmod(zn, BLS_MODULUS - 1, BLS_MODULUS);
        uint256 nb = mulmod(n, b, BLS_MODULUS);
        uint256 den = mulmod(nb, vanishing, BLS_MODULUS);
        if (den == 0) revert InvalidBlobProof(); // z is a root of unity
        uint256 num = addmod(mulmod(y, nb, BLS_MODULUS), BLS_MODULUS - mulmod(vanishing, a, BLS_MODULUS), BLS_MODULUS);
        return mulmod(num, _inverse(den), BLS_MODULUS);
    }

    /// @dev The point evaluation precompile: the polynomial committed to by `commitment` (with
    ///      `versionedHash`) is `y` at `z`, by the 48-byte opening at `proof[offset:]`.
    function _open(
        bytes32 versionedHash,
        uint256 z,
        uint256 y,
        bytes memory commitment,
        bytes memory proof,
        uint256 offset
    ) private view {
        bytes memory opening = new bytes(48);
        assembly ("memory-safe") {
            mcopy(add(opening, 32), add(add(proof, 32), offset), 48)
        }
        (bool ok, bytes memory ret) =
            POINT_EVALUATION.staticcall(abi.encodePacked(versionedHash, z, y, commitment, opening));
        if (!ok || ret.length != 64) revert InvalidBlobProof();
        (uint256 elements, uint256 modulus) = abi.decode(ret, (uint256, uint256));
        if (elements != FIELD_ELEMENTS_PER_BLOB || modulus != BLS_MODULUS) revert InvalidBlobProof();
    }

    function _inverse(uint256 v) private view returns (uint256) {
        (bool ok, bytes memory ret) = MODEXP.staticcall(abi.encode(32, 32, 32, v, BLS_MODULUS - 2, BLS_MODULUS));
        if (!ok) revert InvalidBlobProof();
        return abi.decode(ret, (uint256));
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
}
