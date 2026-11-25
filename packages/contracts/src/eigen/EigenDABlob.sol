// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

/// @notice The first evaluations of an EigenDA blob, proven against its KZG commitment (BN254, EigenDA's
///         trusted setup). A blob is the coefficients of a polynomial p; its payload is p's evaluations at
///         w^0, w^1, ... (w: the blob size's root of unity).
/// @dev The proof is EigenDAKZG.prove in packages/registrar-indexer/src/eigenda.ts; the challenge is
///      eigenDAChallenge in packages/shared/src/eigenda.ts (keep them in step).
library EigenDABlob {
    error InvalidBlob();
    error InvalidBlobProof();

    uint256 constant R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    uint256 constant P = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;
    /// @dev Scale2RootOfUnity[28] (EigenDA encoding/constants.go): a primitive 2^28-th root of unity
    uint256 constant ROOT_OF_UNITY_28 = 19103219067921713944291392827692070036145651957329286315305642004821462161904;
    /// @dev the commitment to q (64 bytes), p(z) (32), and the openings of p and q at z (64 each)
    uint256 constant PROOF_BYTES = 224;

    // G2 points in EIP-197 order (x imaginary, x real, y imaginary, y real): the generator and tau * G2
    // (EigenDA resources/srs/g2.point, points 0 and 1)
    uint256 constant G2_XI = 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2;
    uint256 constant G2_XR = 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed;
    uint256 constant G2_YI = 0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b;
    uint256 constant G2_YR = 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa;
    uint256 constant TAU_G2_XI = 0x172aa93c41f16e1e04d62ac976a5d945f4be0acab990c6dc19ac4a7cf68bf77b;
    uint256 constant TAU_G2_XR = 0x2ae0c8c3a090f7200ff398ee9845bbae8f8c1445ae7b632212775f60a0e21600;
    uint256 constant TAU_G2_YI = 0x1754a9fc3b7e4da9197c283c7401773208190c5555caf254e644e99c29366704;
    uint256 constant TAU_G2_YR = 0x1459fe6cc8a1222fd4290864ff9e47d4b8cf7a403593c7107c39538ddefd857e;

    struct G1 {
        uint256 x;
        uint256 y;
    }

    /// @notice Check that `evaluations` (k x 32 bytes) are p(w^0..w^(k-1)) for the blob of `length`
    ///         symbols committed to by `commitment`.
    /// @dev Z = prod_{i<k} (X - w^i) and I interpolates the evaluations. The prover commits to
    ///      q = (p - I) / Z, which is a polynomial only if the evaluations are p's. At z = hash(everything
    ///      chosen), p(z) = I(z) + q(z) Z(z) then holds for wrong evaluations with probability about
    ///      2 * length / R. `proof` gives p(z); q(z) follows, and both openings are checked with one pairing.
    function verify(G1 memory commitment, uint256 length, bytes memory evaluations, bytes memory proof) internal view {
        uint256 k = evaluations.length >> 5;
        if (
            evaluations.length & 31 != 0 || k == 0 || k > length || length > 1 << 28 || length & (length - 1) != 0
                || proof.length != PROOF_BYTES
        ) revert InvalidBlob();
        G1 memory quotient;
        uint256 y;
        assembly ("memory-safe") {
            mstore(quotient, mload(add(proof, 32)))
            mstore(add(quotient, 32), mload(add(proof, 64)))
            y := mload(add(proof, 96))
        }
        uint256 z = uint256(
            keccak256(abi.encodePacked(commitment.x, commitment.y, quotient.x, quotient.y, length, evaluations))
        ) % R;
        uint256 qz = _quotientAt(evaluations, k, _root(length), length, z, y);
        G1 memory openP;
        G1 memory openQ;
        assembly ("memory-safe") {
            mstore(openP, mload(add(proof, 128)))
            mstore(add(openP, 32), mload(add(proof, 160)))
            mstore(openQ, mload(add(proof, 192)))
            mstore(add(openQ, 32), mload(add(proof, 224)))
        }
        // e(C - y G + z pi, G2) = e(pi, tau G2) for each opening, combined with a random gamma
        uint256 gamma = uint256(keccak256(abi.encodePacked(z, y, openP.x, openP.y, openQ.x, openQ.y))) % R;
        G1 memory b = _add(openP, _mul(openQ, gamma));
        G1 memory a = _add(commitment, _mul(quotient, gamma));
        a = _add(a, _mul(G1(1, 2), R - addmod(y, mulmod(gamma, qz, R), R)));
        a = _add(a, _mul(b, z));
        if (!_pairing(a, b)) revert InvalidBlobProof();
    }

    function _root(uint256 length) private pure returns (uint256 w) {
        w = ROOT_OF_UNITY_28;
        for (uint256 s = 1 << 28; s > length; s >>= 1) {
            w = mulmod(w, w, R);
        }
    }

    /// @dev q(z) = (p(z) - I(z)) / Z(z). I(z) = Z(z) * sum_i e_i / ((z - x_i) Z'(x_i)) (barycentric), with
    ///      x_i = w^i; the sum is kept as a fraction a / b, so there's one inversion.
    function _quotientAt(bytes memory evaluations, uint256 k, uint256 w, uint256 length, uint256 z, uint256 y)
        private
        view
        returns (uint256)
    {
        uint256[] memory weights = _weights(w, length, k);
        unchecked {
            uint256 a;
            uint256 b = 1;
            uint256 zz = 1; // Z(z)
            uint256 x = 1; // w^i
            for (uint256 i; i < k; ++i) {
                uint256 e;
                assembly ("memory-safe") {
                    e := mload(add(add(evaluations, 32), shl(5, i)))
                }
                if (e >= R) revert InvalidBlob();
                uint256 d = addmod(z, R - x, R);
                zz = mulmod(zz, d, R);
                d = mulmod(d, weights[i], R);
                a = addmod(mulmod(a, d, R), mulmod(e, b, R), R);
                b = mulmod(b, d, R);
                x = mulmod(x, w, R);
            }
            uint256 den = mulmod(b, zz, R);
            if (den == 0) revert InvalidBlobProof(); // z is one of the points
            return mulmod(addmod(mulmod(y, b, R), R - mulmod(a, zz, R), R), _pow(den, R - 2), R);
        }
    }

    /// @dev Z'(x_i) = prod_{j != i} (x_i - x_j) = w^(i(k-1)) prod_{d=1..i} (1 - w^-d) prod_{d=1..k-1-i} (1 - w^d),
    ///      from prefix products of (1 - w^d) and (1 - w^-d).
    function _weights(uint256 w, uint256 length, uint256 k) private view returns (uint256[] memory weights) {
        uint256[] memory up = new uint256[](k); // prod_{d=1..m} (1 - w^d)
        weights = new uint256[](k); // first prod_{d=1..m} (1 - w^-d), then Z'(x_i)
        uint256 wInv = _pow(w, length - 1);
        unchecked {
            up[0] = 1;
            weights[0] = 1;
            uint256 wd = 1;
            uint256 wdInv = 1;
            for (uint256 m = 1; m < k; ++m) {
                wd = mulmod(wd, w, R);
                wdInv = mulmod(wdInv, wInv, R);
                up[m] = mulmod(up[m - 1], addmod(1, R - wd, R), R);
                weights[m] = mulmod(weights[m - 1], addmod(1, R - wdInv, R), R);
            }
            uint256 stride = _pow(w, k - 1);
            uint256 scale = 1; // w^(i(k-1))
            for (uint256 i; i < k; ++i) {
                weights[i] = mulmod(mulmod(weights[i], up[k - 1 - i], R), scale, R);
                scale = mulmod(scale, stride, R);
            }
        }
    }

    function _pow(uint256 base, uint256 e) private view returns (uint256) {
        (bool ok, bytes memory ret) = address(0x05).staticcall(abi.encode(32, 32, 32, base, e, R));
        if (!ok) revert InvalidBlobProof();
        return abi.decode(ret, (uint256));
    }

    function _add(G1 memory p, G1 memory q) private view returns (G1 memory r) {
        (bool ok, bytes memory ret) = address(0x06).staticcall(abi.encode(p.x, p.y, q.x, q.y));
        if (!ok) revert InvalidBlobProof(); // not on the curve
        (r.x, r.y) = abi.decode(ret, (uint256, uint256));
    }

    function _mul(G1 memory p, uint256 s) private view returns (G1 memory r) {
        (bool ok, bytes memory ret) = address(0x07).staticcall(abi.encode(p.x, p.y, s));
        if (!ok) revert InvalidBlobProof();
        (r.x, r.y) = abi.decode(ret, (uint256, uint256));
    }

    /// @dev e(a, G2) * e(-b, tau G2) == 1
    function _pairing(G1 memory a, G1 memory b) private view returns (bool) {
        uint256 negY = b.y == 0 ? 0 : P - (b.y % P);
        (bool ok, bytes memory ret) = address(0x08)
            .staticcall(
                abi.encode(a.x, a.y, G2_XI, G2_XR, G2_YI, G2_YR, b.x, negY, TAU_G2_XI, TAU_G2_XR, TAU_G2_YI, TAU_G2_YR)
            );
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }
}
