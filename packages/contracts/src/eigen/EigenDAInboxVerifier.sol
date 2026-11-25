// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";
import {RLPReader} from "../lib/optimism/RLPReader.sol";
import {OPBatchInbox} from "../op/OPBatchInbox.sol";
import {OPBatchPrefix} from "../op/OPBatchPrefix.sol";
import {ISystemConfig, OPInboxVerifierBase} from "../op/OPInboxVerifierBase.sol";
import {EigenDABlob} from "./EigenDABlob.sol";

struct EigenDAInboxCommitProof {
    bytes l1Header; // RLP header of the L1 block with the batcher transaction
    uint256 txIndex; // the transaction's index in that block
    bytes[] txProof; // its proof in the block's transactions trie
    bytes evaluations; // the EigenDA blob's first evaluations (32 bytes each)
    bytes blobProof; // EigenDABlob.verify's proof of them
    bytes l2Header; // RLP header of the L2 block the batch names as its parent
}

/// @notice IL2StorageVerifier for an OP Stack chain with EigenDA alt-DA (Celo), from its batcher's posts:
///         OPBatchInboxVerifier with the batch in an EigenDA blob instead of an L1 blob (docs/eigenda-inbox.md).
///         Like it, it trusts the batcher key.
/// @dev The commit proof shows: an L1 block (by hash), an EIP-1559 transaction in it from the batcher to
///      the batch inbox whose calldata is an EigenDA certificate, the start of a channel in that
///      certificate's blob (EigenDABlob: its first evaluations against the blob's KZG commitment), an L1
///      origin in the sequencing window, and an L2 header that hashes to the batch's parent. The
///      certificate's own validity (EigenDA's operators signed it) isn't checked: the batcher is trusted.
contract EigenDAInboxVerifier is OPInboxVerifierBase {
    error InvalidCertificate();

    /// @dev alt-DA calldata: version 0x01, generic commitment 0x01, EigenDA 0x00, certificate version 0x02
    bytes4 constant CERT_PREFIX = 0x01010002;

    constructor(ISystemConfig systemConfig_, address batchInbox_, uint256 maxOriginLag_, uint256 maxL1BlockLag_)
        OPInboxVerifierBase(systemConfig_, batchInbox_, maxOriginLag_, maxL1BlockLag_)
    {}

    /// @inheritdoc IL2StorageVerifier
    /// @dev `commitProof` = abi.encode(EigenDAInboxCommitProof), `accountProof` = abi.encode(bytes[])
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32)
    {
        bytes32 stateRoot = verifyStateRoot(abi.decode(commitProof, (EigenDAInboxCommitProof)));
        return EthTrie.getStorageRoot(stateRoot, target, abi.decode(accountProof, (bytes[])));
    }

    /// @notice Verify `p` against L1 and return the state root of the batch's parent L2 block.
    function verifyStateRoot(EigenDAInboxCommitProof memory p) public view returns (bytes32) {
        (uint256 l1Block, bytes memory txn) = _l1Transaction(p.l1Header, p.txIndex, p.txProof);
        // 0x02 . rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas, to, value, data,
        // access_list, y_parity, r, s])
        RLPReader.RLPItem[] memory f = _batcherTransaction(txn, 0x02, 12);
        (EigenDABlob.G1 memory commitment, uint256 length) = _certificate(RLPReader.readBytes(f[7]));
        EigenDABlob.verify(commitment, length, p.evaluations, p.blobProof);
        (, OPBatchPrefix.Batch memory batch) = OPBatchInbox.decodeBatch(payload(p.evaluations));
        return _parentStateRoot(l1Block, batch, p.l2Header);
    }

    /// @notice The payload the evaluations carry: a header element (0x00, version 0x00, big-endian uint32
    ///         length, zeros), then 31 bytes after a 0x00 byte per element; as much as they carry.
    /// @dev Port of eigenDAPayloadPrefix in packages/shared/src/eigenda.ts.
    function payload(bytes memory evaluations) public pure returns (bytes memory out) {
        uint256 k = evaluations.length >> 5;
        if (k == 0 || evaluations.length & 31 != 0) revert EigenDABlob.InvalidBlob();
        uint256 head;
        assembly ("memory-safe") {
            head := mload(add(evaluations, 32))
        }
        // 0x00, version 0x00, length (4 bytes), 26 zero bytes
        if (head >> 240 != 0 || head & ((1 << 208) - 1) != 0) revert EigenDABlob.InvalidBlob();
        uint256 length = (head >> 208) & 0xffffffff;
        uint256 n = (k - 1) * 31;
        if (length < n) n = length;
        out = new bytes((k - 1) * 31 + 1); // +1: the last 32-byte store runs one past
        assembly ("memory-safe") {
            mstore(out, n)
        }
        for (uint256 i = 1; i < k; ++i) {
            uint256 e;
            assembly ("memory-safe") {
                e := mload(add(evaluations, add(32, shl(5, i))))
            }
            if (e >> 248 != 0) revert EigenDABlob.InvalidBlob();
            assembly ("memory-safe") {
                mstore(add(add(out, 32), mul(sub(i, 1), 31)), shl(8, e))
            }
        }
    }

    /// @dev The blob's commitment and length from alt-DA calldata with an EigenDA certificate (V3, RLP):
    ///      cert[1] blobInclusionInfo, [0] blobCertificate, [0] blobHeader, [2] commitments: [G1, G2, G2, length]
    function _certificate(bytes memory data) internal pure returns (EigenDABlob.G1 memory commitment, uint256 length) {
        if (data.length < 5 || bytes4(data) != CERT_PREFIX) revert InvalidCertificate();
        bytes memory rlp = new bytes(data.length - 4);
        assembly ("memory-safe") {
            mcopy(add(rlp, 32), add(data, 36), mload(rlp))
        }
        RLPReader.RLPItem[] memory cert = RLPReader.readList(rlp);
        if (cert.length != 4) revert InvalidCertificate();
        RLPReader.RLPItem[] memory header = RLPReader.readList(RLPReader.readList(RLPReader.readList(cert[1])[0])[0]);
        RLPReader.RLPItem[] memory commitments = RLPReader.readList(header[2]);
        RLPReader.RLPItem[] memory g1 = RLPReader.readList(commitments[0]);
        commitment = EigenDABlob.G1(_uint(g1[0]), _uint(g1[1]));
        length = _uint(commitments[3]);
    }
}
