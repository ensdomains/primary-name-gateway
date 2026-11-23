// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {LineaTrie} from "./LineaTrie.sol";

/// @dev Subset of Linea's L1 `LineaRollup`.
interface ILineaRollup {
    /// @dev Set for the last L2 block of every finalization (ZK proven).
    function stateRootHashes(uint256 l2BlockNumber) external view returns (bytes32);
    function currentL2BlockNumber() external view returns (uint256);
}

/// @title LineaVerifier
/// @notice Verifies Linea storage against a finalized L2 block on L1.
/// @dev `commitProof` = abi.encode(uint256 l2BlockNumber): a finalized block (`stateRootHashes` is set)
///      `accountProof` = abi.encode(LineaTrie.MultiProof) with the target's leaf (it must exist)
///      storage `proof` = abi.encode(LineaTrie.MultiProof) with, for each slot, its leaf or the two
///      adjacent leaves around it
contract LineaVerifier is IL2StorageVerifier {
    error NotFinalized(uint256 l2BlockNumber);
    error StaleCommit(uint256 l2BlockNumber, uint256 currentL2BlockNumber);
    error AccountNotFound(address target);

    ILineaRollup public immutable rollup;
    /// @notice How many L2 blocks a commit may lag behind the latest finalized block
    ///         (`currentL2BlockNumber()`), i.e. how stale a proven value may be. Must exceed the blocks
    ///         between finalizations plus the gateway's margin, or a gateway's fallback commit is rejected.
    uint256 public immutable maxBlockLag;

    constructor(ILineaRollup rollup_, uint256 maxBlockLag_) {
        rollup = rollup_;
        maxBlockLag = maxBlockLag_;
    }

    /// @inheritdoc IL2StorageVerifier
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32)
    {
        bytes32 stateRoot = verifyStateRoot(abi.decode(commitProof, (uint256)));
        LineaTrie.MultiProof memory p = abi.decode(accountProof, (LineaTrie.MultiProof));
        LineaTrie.verifyLeaves(stateRoot, p);
        (bool found, uint256 pos) = LineaTrie.find(p, LineaTrie.hashAccountKey(target));
        if (!found) revert AccountNotFound(target);
        bytes memory account = p.values[pos];
        if (LineaTrie.hashAccountValue(account) != LineaTrie.hValueOf(p, pos)) revert LineaTrie.InvalidProof();
        return LineaTrie.storageRootOf(account);
    }

    /// @inheritdoc IL2StorageVerifier
    function verifyStorageValues(bytes32 storageRoot, uint256[] calldata slots, bytes calldata proof)
        external
        pure
        returns (bytes32[] memory values)
    {
        LineaTrie.MultiProof memory p = abi.decode(proof, (LineaTrie.MultiProof));
        LineaTrie.verifyLeaves(storageRoot, p);
        values = new bytes32[](slots.length);
        for (uint256 i; i < slots.length; ++i) {
            (bool found, uint256 pos) = LineaTrie.find(p, LineaTrie.hashWord(bytes32(slots[i])));
            if (!found) continue;
            bytes memory raw = p.values[pos];
            if (raw.length != 32) revert LineaTrie.InvalidProof();
            bytes32 value = bytes32(raw);
            if (LineaTrie.hashWord(value) != LineaTrie.hValueOf(p, pos)) revert LineaTrie.InvalidProof();
            values[i] = value;
        }
    }

    /// @notice The state root of a finalized L2 block at most `maxBlockLag` blocks behind the latest.
    function verifyStateRoot(uint256 l2BlockNumber) public view returns (bytes32 stateRoot) {
        stateRoot = rollup.stateRootHashes(l2BlockNumber);
        if (stateRoot == 0) revert NotFinalized(l2BlockNumber);
        uint256 current = rollup.currentL2BlockNumber();
        if (l2BlockNumber + maxBlockLag < current) revert StaleCommit(l2BlockNumber, current);
    }
}
