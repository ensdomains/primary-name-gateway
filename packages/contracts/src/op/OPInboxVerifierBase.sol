// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";
import {MerkleTrie} from "../lib/optimism/MerkleTrie.sol";
import {RLPReader} from "../lib/optimism/RLPReader.sol";
import {OPBatchPrefix} from "./OPBatchPrefix.sol";

/// @dev Subset of OP's SystemConfig.
interface ISystemConfig {
    function batcherHash() external view returns (bytes32);
}

/// @notice What the batch inbox verifiers share (docs/op-batch-inbox.md): an L1 block (by hash: BLOCKHASH
///         or EIP-2935 history), a transaction in it from the batcher to the batch inbox, an L1 origin
///         recent enough to be in the sequencing window, and an L2 header that hashes to the batch's
///         parent. Where the batch itself is read from is the subclass's: an L1 blob
///         (OPBatchInboxVerifier) or an EigenDA blob (EigenDAInboxVerifier).
abstract contract OPInboxVerifierBase is IL2StorageVerifier {
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
    uint256 public immutable maxL1BlockLag;

    constructor(ISystemConfig systemConfig_, address batchInbox_, uint256 maxOriginLag_, uint256 maxL1BlockLag_) {
        systemConfig = systemConfig_;
        batchInbox = batchInbox_;
        maxOriginLag = maxOriginLag_;
        maxL1BlockLag = maxL1BlockLag_;
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

    /// @dev The L1 block (recent enough) and its transaction `txIndex`, as signed.
    function _l1Transaction(bytes memory l1Header, uint256 txIndex, bytes[] memory txProof)
        internal
        view
        returns (uint256 l1Block, bytes memory txn)
    {
        RLPReader.RLPItem[] memory l1 = RLPReader.readList(l1Header);
        l1Block = _uint(l1[8]);
        bytes32 l1Hash = _l1BlockHash(l1Block);
        if (l1Hash == bytes32(0) || keccak256(l1Header) != l1Hash) revert InvalidL1Header();
        if (l1Block + maxL1BlockLag < block.number) revert StaleCommit(l1Block);
        bool exists;
        (exists, txn) = MerkleTrie.get(_rlpIndex(txIndex), txProof, EthTrie.toBytes32(RLPReader.readBytes(l1[4])));
        if (!exists) revert InvalidTransaction();
    }

    /// @dev The fields of a typed transaction (EIP-2718) of `txType` with `count` fields, the last three
    ///      (y_parity, r, s) signing 0x0N . rlp(the rest), sent by the batcher to the batch inbox
    ///      (`to` is field 5 in types 2 and 3).
    function _batcherTransaction(bytes memory txn, uint8 txType, uint256 count)
        internal
        view
        returns (RLPReader.RLPItem[] memory f)
    {
        if (txn.length < 2 || uint8(txn[0]) != txType) revert InvalidTransaction();
        bytes memory payload = new bytes(txn.length - 1);
        assembly ("memory-safe") {
            mcopy(add(payload, 32), add(txn, 33), mload(payload))
        }
        f = RLPReader.readList(payload);
        if (f.length != count) revert InvalidTransaction();
        bytes memory to = RLPReader.readBytes(f[5]);
        if (to.length != 20 || address(bytes20(to)) != batchInbox) revert InvalidTransaction();
        // the signed fields are contiguous in `payload`
        uint256 start = RLPReader.MemoryPointer.unwrap(f[0].ptr);
        uint256 len = RLPReader.MemoryPointer.unwrap(f[count - 4].ptr) + f[count - 4].length - start;
        bytes memory unsigned = bytes.concat(bytes1(txType), _listHeader(len), new bytes(len));
        assembly ("memory-safe") {
            mcopy(add(unsigned, sub(add(32, mload(unsigned)), len)), start, len)
        }
        uint256 yParity = _uint(f[count - 3]);
        if (yParity > 1) revert InvalidTransaction();
        address sender = ecrecover(
            keccak256(unsigned),
            uint8(27 + yParity),
            EthTrie.toBytes32(RLPReader.readBytes(f[count - 2])),
            EthTrie.toBytes32(RLPReader.readBytes(f[count - 1]))
        );
        address batcher = address(uint160(uint256(systemConfig.batcherHash())));
        if (sender == address(0) || sender != batcher) revert NotBatcher(sender);
    }

    /// @dev The batch's L1 origin is in the sequencing window, and `l2Header` is its parent: its state root.
    function _parentStateRoot(uint256 l1Block, OPBatchPrefix.Batch memory batch, bytes memory l2Header)
        internal
        view
        returns (bytes32)
    {
        if (l1Block > batch.l1OriginNum + maxOriginLag) revert OutsideSequencingWindow(l1Block, batch.l1OriginNum);
        bytes32 l2Hash = keccak256(l2Header);
        if (batch.batchType == OPBatchPrefix.SINGULAR
                ? l2Hash != batch.parent
                : bytes20(l2Hash) != bytes20(batch.parent)) {
            revert InvalidL2Header();
        }
        return EthTrie.toBytes32(RLPReader.readBytes(RLPReader.readList(l2Header)[3]));
    }

    /// @dev Hash of an L1 block, if it's one of the last 8191 (0 otherwise).
    function _l1BlockHash(uint256 n) internal view virtual returns (bytes32 h) {
        if (n >= block.number) return 0;
        if (block.number - n <= 256) return blockhash(n);
        (bool ok, bytes memory ret) = HISTORY_STORAGE.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    function _uint(RLPReader.RLPItem memory item) internal pure returns (uint256) {
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
