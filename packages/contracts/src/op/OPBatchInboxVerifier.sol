// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";
import {RLPReader} from "../lib/optimism/RLPReader.sol";
import {OPBatchInbox} from "./OPBatchInbox.sol";
import {OPBatchPrefix} from "./OPBatchPrefix.sol";
import {ISystemConfig, OPInboxVerifierBase} from "./OPInboxVerifierBase.sol";

struct OPBatchInboxCommitProof {
    bytes l1Header; // RLP header of the L1 block with the batcher transaction
    uint256 txIndex; // the transaction's index in that block
    bytes[] txProof; // its proof in the block's transactions trie
    uint256 blobIndex; // the blob that starts the channel
    bytes commitment; // the blob's KZG commitment
    bytes fieldElements; // the blob's first field elements (a power of two, at least 4)
    bytes blobProof; // OPBlob.verify's proof of them
    bytes l2Header; // RLP header of the L2 block the batch names as its parent
}

/// @notice IL2StorageVerifier for an OP Stack chain from its batcher's posts
///         (docs/op-batch-inbox.md). It trusts the batcher key: a batch's parent is a block the batcher
///         says it built on. That's only as safe as the batcher, but it's minutes behind the L2
///         instead of days.
/// @dev The commit proof shows: an L1 block (by hash: BLOCKHASH or EIP-2935 history), a type-3
///      transaction in it from the batcher to the batch inbox, the start of a channel in one of its
///      blobs (OPBatchInbox), an L1 origin recent enough to be in the sequencing window, and an L2
///      header that hashes to the batch's parent. The state root is that header's.
contract OPBatchInboxVerifier is OPInboxVerifierBase {
    constructor(ISystemConfig systemConfig_, address batchInbox_, uint256 maxOriginLag_, uint256 maxL1BlockLag_)
        OPInboxVerifierBase(systemConfig_, batchInbox_, maxOriginLag_, maxL1BlockLag_)
    {}

    /// @inheritdoc IL2StorageVerifier
    /// @dev `commitProof` = abi.encode(OPBatchInboxCommitProof), `accountProof` = abi.encode(bytes[])
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32)
    {
        bytes32 stateRoot = verifyStateRoot(abi.decode(commitProof, (OPBatchInboxCommitProof)));
        return EthTrie.getStorageRoot(stateRoot, target, abi.decode(accountProof, (bytes[])));
    }

    /// @notice Verify `p` against L1 and return the state root of the batch's parent L2 block.
    function verifyStateRoot(OPBatchInboxCommitProof memory p) public view returns (bytes32) {
        (uint256 l1Block, bytes memory txn) = _l1Transaction(p.l1Header, p.txIndex, p.txProof);
        // 0x03 . rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas, to, value, data,
        // access_list, max_fee_per_blob_gas, blob_versioned_hashes, y_parity, r, s])
        RLPReader.RLPItem[] memory f = _batcherTransaction(txn, 0x03, 14);
        RLPReader.RLPItem[] memory hashes = RLPReader.readList(f[10]);
        if (p.blobIndex >= hashes.length) revert InvalidTransaction();
        bytes32 versionedHash = EthTrie.toBytes32(RLPReader.readBytes(hashes[p.blobIndex]));
        // the first batch of the channel the blob starts
        (, OPBatchPrefix.Batch memory batch) =
            OPBatchInbox.readBatch(versionedHash, p.commitment, p.fieldElements, p.blobProof);
        return _parentStateRoot(l1Block, batch, p.l2Header);
    }
}
