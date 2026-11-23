// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

/// @notice Reads the first batch of an OP Stack channel from the start of its decompressed data.
/// @dev Port of packages/shared/src/op-batch.ts (keep them in step).
///      Channel data = rlp(batch) ..., batch = type byte . payload.
///      https://specs.optimism.io/protocol/derivation.html#batch-format
///      https://specs.optimism.io/protocol/delta/span-batches.html
library OPBatchPrefix {
    error InvalidBatchPrefix();

    uint256 constant SINGULAR = 0;
    uint256 constant SPAN = 1;

    struct Batch {
        uint256 batchType; // SINGULAR (Base) or SPAN (OP Mainnet)
        bytes32 parent; // parent L2 block hash (span: first 20 bytes, rest zero)
        uint256 l1OriginNum; // singular: epoch number; span: L1 origin of the last block
        bytes32 l1Origin; // singular: epoch hash; span: first 20 bytes of the last block's L1 origin hash
        uint256 timestamp; // singular: block timestamp; span: first block's timestamp - L2 genesis time
    }

    function decode(bytes memory data) internal pure returns (Batch memory b) {
        uint256 pos;
        (, pos) = _header(data, 0, false); // the batch, as an RLP string
        if (pos >= data.length) revert InvalidBatchPrefix();
        b.batchType = uint8(data[pos++]);
        if (b.batchType == SINGULAR) {
            // rlp([parent_hash, epoch_num, epoch_hash, timestamp, transaction_list])
            (, pos) = _header(data, pos, true);
            uint256 len;
            (len, pos) = _header(data, pos, false);
            if (len != 32) revert InvalidBatchPrefix();
            b.parent = _word(data, pos, 32);
            (len, pos) = _header(data, pos + 32, false);
            b.l1OriginNum = _uint(data, pos, len);
            (len, pos) = _header(data, pos + len, false);
            if (len != 32) revert InvalidBatchPrefix();
            b.l1Origin = _word(data, pos, 32);
            (len, pos) = _header(data, pos + 32, false);
            b.timestamp = _uint(data, pos, len);
        } else if (b.batchType == SPAN) {
            // rel_timestamp, l1_origin_num (uvarints), parent_check, l1_origin_check (bytes20)
            (b.timestamp, pos) = _uvarint(data, pos);
            (b.l1OriginNum, pos) = _uvarint(data, pos);
            b.parent = _word(data, pos, 20);
            b.l1Origin = _word(data, pos + 20, 20);
        } else {
            revert InvalidBatchPrefix();
        }
    }

    /// @dev RLP item header at `pos`: returns the payload length and its position.
    ///      A string's single byte < 0x80 is its own payload.
    function _header(bytes memory data, uint256 pos, bool list) private pure returns (uint256 len, uint256 at) {
        if (pos >= data.length) revert InvalidBatchPrefix();
        uint256 b = uint8(data[pos]);
        (uint256 short, uint256 long) = list ? (0xc0, 0xf7) : (0x80, 0xb7);
        if (!list && b < 0x80) return (1, pos);
        if (b < short || b > long + 8) revert InvalidBatchPrefix();
        if (b <= long) return (b - short, pos + 1);
        uint256 n = b - long;
        len = _uint(data, pos + 1, n);
        at = pos + 1 + n;
    }

    function _uvarint(bytes memory data, uint256 pos) private pure returns (uint256 v, uint256 end) {
        for (uint256 shift; shift <= 63; shift += 7) {
            if (pos >= data.length) revert InvalidBatchPrefix();
            uint256 b = uint8(data[pos++]);
            v |= (b & 0x7f) << shift;
            if (b < 0x80) return (v, pos);
        }
        revert InvalidBatchPrefix();
    }

    /// @dev Big-endian unsigned integer of `len` bytes (<= 32).
    function _uint(bytes memory data, uint256 pos, uint256 len) private pure returns (uint256 v) {
        if (len > 32 || pos + len > data.length) revert InvalidBatchPrefix();
        for (uint256 i; i < len; ++i) {
            v = (v << 8) | uint8(data[pos + i]);
        }
    }

    /// @dev `len` bytes (<= 32) at `pos`, left-aligned.
    function _word(bytes memory data, uint256 pos, uint256 len) private pure returns (bytes32 v) {
        if (pos + len > data.length) revert InvalidBatchPrefix();
        assembly ("memory-safe") {
            v := mload(add(add(data, 32), pos))
        }
        v &= bytes32(type(uint256).max << ((32 - len) << 3));
    }
}
