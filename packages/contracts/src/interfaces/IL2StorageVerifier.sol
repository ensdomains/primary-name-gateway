// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Verifies L2 storage against a commitment posted to L1.
/// @dev One implementation per L2 family (OP Stack fault proofs, Arbitrum, Linea, ...),
///      deployed per chain. Callers only deal with opaque `commitProof` bytes.
interface IL2StorageVerifier {
    /// @notice Verify `commitProof` against L1, then `accountProof` against the committed state root.
    /// @return storageRoot The storage root of `target` on the L2.
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes[] calldata accountProof)
        external
        view
        returns (bytes32 storageRoot);

    /// @notice Verify one storage slot against a storage root returned by `verifyStorageRoot()`.
    /// @dev Unset slots are proven with an exclusion proof and return 0.
    function verifyStorageValue(bytes32 storageRoot, uint256 slot, bytes[] calldata proof)
        external
        view
        returns (bytes32 value);
}
