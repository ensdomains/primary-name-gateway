// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";
import {MerkleTrie} from "../lib/optimism/MerkleTrie.sol";
import {RLPReader} from "../lib/optimism/RLPReader.sol";
import {OPBatchInbox} from "./OPBatchInbox.sol";
import {OPBatchPrefix} from "./OPBatchPrefix.sol";

/// @dev Subset of OP's SystemConfig.
interface ISystemConfig {
    function batcherHash() external view returns (bytes32);
}

struct OPBatchInboxCommitProof {
    bytes l1Header; // RLP header of the L1 block with the batcher transaction
    uint256 txIndex; // the transaction's index in that block
    bytes[] txProof; // its proof in the block's transactions trie
    uint256 blobIndex; // the blob that starts the channel
    bytes commitment; // the blob's KZG commitment
    bytes fieldElements; // the blob's first field elements (whole rounds of 4)
    bytes[] blobProofs; // a point evaluation proof per field element
    bytes l2Header; // RLP header of the L2 block the batch names as its parent
}

/// @notice IL2StorageVerifier for an OP Stack chain from its batcher's posts (research:
///         docs/op-batch-inbox.md). It trusts the batcher key: a batch's parent is a block the batcher
///         says it built on. That's only as safe as the batcher, but it's minutes behind the L2
///         instead of days.
/// @dev The commit proof shows: an L1 block (by hash: BLOCKHASH or EIP-2935 history), a type-3
///      transaction in it from the batcher to the batch inbox, the start of a channel in one of its
///      blobs (OPBatchInbox), an L1 origin recent enough to be in the sequencing window, and an L2
///      header that hashes to the batch's parent. The state root is that header's.
contract OPBatchInboxVerifier is IL2StorageVerifier {
    error InvalidL1Header();
    error StaleCommit(uint256 l1Block);
    error InvalidTransaction();
    error NotBatcher(address sender);
    error OutsideSequencingWindow(uint256 l1Block, uint256 l1Origin);
    error InvalidL2Header();
    error InvalidStorageProof();

    /// @dev EIP-2935: hashes of the last 8191 blocks
    address constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;

    ISystemConfig public immutable systemConfig;
    address public immutable batchInbox;
    /// @notice A batch must be posted within this many L1 blocks of its L1 origin (less than the
    ///         chain's sequencing window, 3600 on OP Mainnet and Base): a later batch is dropped.
    uint256 public immutable maxOriginLag;
    /// @notice Accept batcher transactions at most this many L1 blocks old.
    uint256 public immutable maxBlockLag;

    constructor(ISystemConfig systemConfig_, address batchInbox_, uint256 maxOriginLag_, uint256 maxBlockLag_) {
        systemConfig = systemConfig_;
        batchInbox = batchInbox_;
        maxOriginLag = maxOriginLag_;
        maxBlockLag = maxBlockLag_;
    }

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

    /// @inheritdoc IL2StorageVerifier
    /// @dev `proof` = abi.encode(bytes[][]): the eth_getProof storageProof[].proof of each slot
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

    /// @notice Verify `p` against L1 and return the state root of the batch's parent L2 block.
    function verifyStateRoot(OPBatchInboxCommitProof memory p) public view returns (bytes32) {
        // the L1 block
        RLPReader.RLPItem[] memory l1 = RLPReader.readList(p.l1Header);
        uint256 l1Block = _uint(l1[8]);
        bytes32 l1Hash = _l1BlockHash(l1Block);
        if (l1Hash == bytes32(0) || keccak256(p.l1Header) != l1Hash) revert InvalidL1Header();
        if (l1Block + maxBlockLag < block.number) revert StaleCommit(l1Block);
        // the batcher transaction
        (bool exists, bytes memory txn) =
            MerkleTrie.get(_rlpIndex(p.txIndex), p.txProof, EthTrie.toBytes32(RLPReader.readBytes(l1[4])));
        if (!exists) revert InvalidTransaction();
        bytes32 versionedHash = _batcherBlob(txn, p.blobIndex);
        // the first batch of the channel the blob starts
        (, OPBatchPrefix.Batch memory batch) =
            OPBatchInbox.readBatch(versionedHash, p.commitment, p.fieldElements, p.blobProofs);
        if (l1Block > batch.l1OriginNum + maxOriginLag) revert OutsideSequencingWindow(l1Block, batch.l1OriginNum);
        // its parent L2 block
        bytes32 l2Hash = keccak256(p.l2Header);
        if (batch.batchType == OPBatchPrefix.SINGULAR ? l2Hash != batch.parent : bytes20(l2Hash) != bytes20(batch.parent)) {
            revert InvalidL2Header();
        }
        return EthTrie.toBytes32(RLPReader.readBytes(RLPReader.readList(p.l2Header)[3]));
    }

    /// @dev Hash of an L1 block, if it's one of the last 8191 (0 otherwise).
    function _l1BlockHash(uint256 n) internal view virtual returns (bytes32 h) {
        if (n >= block.number) return 0;
        if (block.number - n <= 256) return blockhash(n);
        (bool ok, bytes memory ret) = HISTORY_STORAGE.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    /// @dev The versioned hash of blob `blobIndex` of an EIP-4844 transaction from the batcher to the
    ///      batch inbox: 0x03 . rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas,
    ///      to, value, data, access_list, max_fee_per_blob_gas, blob_versioned_hashes, y_parity, r, s])
    function _batcherBlob(bytes memory txn, uint256 blobIndex) internal view returns (bytes32) {
        if (txn.length < 2 || txn[0] != 0x03) revert InvalidTransaction();
        bytes memory payload = new bytes(txn.length - 1);
        assembly ("memory-safe") {
            mcopy(add(payload, 32), add(txn, 33), mload(payload))
        }
        RLPReader.RLPItem[] memory f = RLPReader.readList(payload);
        if (f.length != 14) revert InvalidTransaction();
        bytes memory to = RLPReader.readBytes(f[5]);
        if (to.length != 20 || address(bytes20(to)) != batchInbox) revert InvalidTransaction();
        RLPReader.RLPItem[] memory hashes = RLPReader.readList(f[10]);
        if (blobIndex >= hashes.length) revert InvalidTransaction();
        // the signer: keccak256(0x03 . rlp(the first 11 fields)), which are contiguous in `payload`
        uint256 start = RLPReader.MemoryPointer.unwrap(f[0].ptr);
        uint256 len = RLPReader.MemoryPointer.unwrap(f[10].ptr) + f[10].length - start;
        bytes memory unsigned = bytes.concat(bytes1(0x03), _listHeader(len), new bytes(len));
        assembly ("memory-safe") {
            mcopy(add(unsigned, sub(add(32, mload(unsigned)), len)), start, len)
        }
        uint256 yParity = _uint(f[11]);
        if (yParity > 1) revert InvalidTransaction();
        address sender = ecrecover(
            keccak256(unsigned), uint8(27 + yParity), EthTrie.toBytes32(RLPReader.readBytes(f[12])),
            EthTrie.toBytes32(RLPReader.readBytes(f[13]))
        );
        address batcher = address(uint160(uint256(systemConfig.batcherHash())));
        if (sender == address(0) || sender != batcher) revert NotBatcher(sender);
        return EthTrie.toBytes32(RLPReader.readBytes(hashes[blobIndex]));
    }

    function _uint(RLPReader.RLPItem memory item) private pure returns (uint256) {
        return uint256(EthTrie.toBytes32(RLPReader.readBytes(item)));
    }

    /// @dev rlp(i): the transactions trie key
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
