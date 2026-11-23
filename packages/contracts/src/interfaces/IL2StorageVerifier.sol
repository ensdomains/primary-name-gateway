// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Verifies L2 storage against a commitment posted to L1.
/// @dev One implementation per L2 family (OP Stack fault proofs, Linea, ...), deployed per chain.
///      Callers only deal with opaque proof bytes: each verifier defines their encoding.
interface IL2StorageVerifier {
    /// @notice Verify `commitProof` against L1, then `accountProof` against the committed state root.
    /// @return storageRoot The storage root of `target` on the L2.
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32 storageRoot);

    /// @notice Verify storage slots against a storage root returned by `verifyStorageRoot()`.
    /// @dev One proof covers all `slots` (verifiers may share work between them, e.g. a multiproof).
    ///      Unset slots are proven absent and read as 0.
    /// @return values `values[i]` is the word at `slots[i]`.
    function verifyStorageValues(bytes32 storageRoot, uint256[] calldata slots, bytes calldata proof)
        external
        view
        returns (bytes32[] memory values);
}
