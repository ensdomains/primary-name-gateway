// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";
import {MerkleTrie} from "../lib/optimism/MerkleTrie.sol";
import {RLPReader} from "../lib/optimism/RLPReader.sol";
import {BrotliPrefix} from "../brotli/BrotliPrefix.sol";
import {OPBatchInbox} from "../op/OPBatchInbox.sol";
import {ISystemConfig} from "../op/OPBatchInboxVerifier.sol";
import {OPBatchPrefix} from "../op/OPBatchPrefix.sol";
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
///         OPBatchInboxVerifier with the batch in an EigenDA blob instead of an L1 blob. Like it, it trusts
///         the batcher key (docs/eigen-inbox.md).
/// @dev EXPERIMENT. The commit proof shows: an L1 block (by hash), an EIP-1559 transaction in it from the
///      batcher to the batch inbox whose calldata is an EigenDA certificate, the start of a channel in
///      that certificate's blob (EigenDABlob: its first evaluations against the blob's KZG commitment),
///      an L1 origin in the sequencing window, and an L2 header that hashes to the batch's parent. The
///      certificate's own validity (EigenDA's operators signed it) isn't checked: the batcher is trusted.
contract EigenDAInboxVerifier is IL2StorageVerifier {
    error InvalidL1Header();
    error StaleCommit(uint256 l1Block);
    error InvalidTransaction();
    error NotBatcher(address sender);
    error InvalidCertificate();
    error OutsideSequencingWindow(uint256 l1Block, uint256 l1Origin);
    error InvalidL2Header();
    error InvalidStorageProof();

    address constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    /// @dev alt-DA calldata: version 0x01, generic commitment 0x01, EigenDA 0x00, certificate version 0x02
    bytes4 constant CERT_PREFIX = 0x01010002;
    /// @dev decompressed bytes to read: enough for a singular batch's prefix
    uint256 constant PREFIX_BYTES = 112;

    ISystemConfig public immutable systemConfig;
    address public immutable batchInbox;
    uint256 public immutable maxOriginLag;
    uint256 public immutable maxL1BlockLag;

    constructor(ISystemConfig systemConfig_, address batchInbox_, uint256 maxOriginLag_, uint256 maxL1BlockLag_) {
        systemConfig = systemConfig_;
        batchInbox = batchInbox_;
        maxOriginLag = maxOriginLag_;
        maxL1BlockLag = maxL1BlockLag_;
    }

    /// @inheritdoc IL2StorageVerifier
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32)
    {
        bytes32 stateRoot = verifyStateRoot(abi.decode(commitProof, (EigenDAInboxCommitProof)));
        return EthTrie.getStorageRoot(stateRoot, target, abi.decode(accountProof, (bytes[])));
    }

    /// @inheritdoc IL2StorageVerifier
    function verifyStorageValues(bytes32 storageRoot, uint256[] calldata slots, bytes calldata proof)
        external
        pure
        returns (bytes32[] memory values)
    {
        bytes[][] memory proofs = abi.decode(proof, (bytes[][]));
        if (proofs.length != slots.length) revert InvalidStorageProof();
        values = new bytes32[](slots.length);
        for (uint256 i; i < slots.length; ++i) {
            values[i] = EthTrie.getStorageValue(storageRoot, slots[i], proofs[i]);
        }
    }

    function verifyStateRoot(EigenDAInboxCommitProof memory p) public view returns (bytes32) {
        RLPReader.RLPItem[] memory l1 = RLPReader.readList(p.l1Header);
        uint256 l1Block = _uint(l1[8]);
        bytes32 l1Hash = _l1BlockHash(l1Block);
        if (l1Hash == bytes32(0) || keccak256(p.l1Header) != l1Hash) revert InvalidL1Header();
        if (l1Block + maxL1BlockLag < block.number) revert StaleCommit(l1Block);
        (bool exists, bytes memory txn) =
            MerkleTrie.get(_rlpIndex(p.txIndex), p.txProof, EthTrie.toBytes32(RLPReader.readBytes(l1[4])));
        if (!exists) revert InvalidTransaction();
        (EigenDABlob.G1 memory commitment, uint256 length) = _certificate(_batcherCalldata(txn));
        EigenDABlob.verify(commitment, length, p.evaluations, p.blobProof);
        (, bytes memory compressed) = OPBatchInbox.channelStart(payload(p.evaluations));
        OPBatchPrefix.Batch memory batch = OPBatchPrefix.decode(BrotliPrefix.decode(compressed, PREFIX_BYTES));
        if (l1Block > batch.l1OriginNum + maxOriginLag) revert OutsideSequencingWindow(l1Block, batch.l1OriginNum);
        bytes32 l2Hash = keccak256(p.l2Header);
        if (batch.batchType == OPBatchPrefix.SINGULAR
                ? l2Hash != batch.parent
                : bytes20(l2Hash) != bytes20(batch.parent)) {
            revert InvalidL2Header();
        }
        return EthTrie.toBytes32(RLPReader.readBytes(RLPReader.readList(p.l2Header)[3]));
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

    /// @dev The calldata of an EIP-1559 transaction from the batcher to the batch inbox:
    ///      0x02 . rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas, to, value, data,
    ///      access_list, y_parity, r, s])
    function _batcherCalldata(bytes memory txn) internal view returns (bytes memory) {
        if (txn.length < 2 || txn[0] != 0x02) revert InvalidTransaction();
        bytes memory body = new bytes(txn.length - 1);
        assembly ("memory-safe") {
            mcopy(add(body, 32), add(txn, 33), mload(body))
        }
        RLPReader.RLPItem[] memory f = RLPReader.readList(body);
        if (f.length != 12) revert InvalidTransaction();
        bytes memory to = RLPReader.readBytes(f[5]);
        if (to.length != 20 || address(bytes20(to)) != batchInbox) revert InvalidTransaction();
        // the signer: keccak256(0x02 . rlp(the first 9 fields)), which are contiguous in `body`
        uint256 start = RLPReader.MemoryPointer.unwrap(f[0].ptr);
        uint256 len = RLPReader.MemoryPointer.unwrap(f[8].ptr) + f[8].length - start;
        bytes memory unsigned = bytes.concat(bytes1(0x02), _listHeader(len), new bytes(len));
        assembly ("memory-safe") {
            mcopy(add(unsigned, sub(add(32, mload(unsigned)), len)), start, len)
        }
        uint256 yParity = _uint(f[9]);
        if (yParity > 1) revert InvalidTransaction();
        address sender = ecrecover(
            keccak256(unsigned),
            uint8(27 + yParity),
            EthTrie.toBytes32(RLPReader.readBytes(f[10])),
            EthTrie.toBytes32(RLPReader.readBytes(f[11]))
        );
        address batcher = address(uint160(uint256(systemConfig.batcherHash())));
        if (sender == address(0) || sender != batcher) revert NotBatcher(sender);
        return RLPReader.readBytes(f[7]);
    }

    function _l1BlockHash(uint256 n) internal view virtual returns (bytes32 h) {
        if (n >= block.number) return 0;
        if (block.number - n <= 256) return blockhash(n);
        (bool ok, bytes memory ret) = HISTORY_STORAGE.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    function _uint(RLPReader.RLPItem memory item) private pure returns (uint256) {
        return uint256(EthTrie.toBytes32(RLPReader.readBytes(item)));
    }

    function _rlpIndex(uint256 i) private pure returns (bytes memory) {
        if (i == 0) return hex"80";
        if (i < 0x80) return abi.encodePacked(uint8(i));
        uint256 n;
        for (uint256 x = i; x != 0; x >>= 8) {
            ++n;
        }
        bytes memory v = new bytes(1 + n);
        v[0] = bytes1(uint8(0x80 + n));
        for (uint256 k; k < n; ++k) {
            v[n - k] = bytes1(uint8(i >> (8 * k)));
        }
        return v;
    }

    function _listHeader(uint256 len) private pure returns (bytes memory) {
        if (len < 56) return abi.encodePacked(uint8(0xc0 + len));
        uint256 n;
        for (uint256 x = len; x != 0; x >>= 8) {
            ++n;
        }
        bytes memory v = new bytes(1 + n);
        v[0] = bytes1(uint8(0xf7 + n));
        for (uint256 k; k < n; ++k) {
            v[n - k] = bytes1(uint8(len >> (8 * k)));
        }
        return v;
    }
}
