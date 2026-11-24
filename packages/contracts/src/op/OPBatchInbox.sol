// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {BrotliPrefix} from "../brotli/BrotliPrefix.sol";
import {OPBatchPrefix} from "./OPBatchPrefix.sol";
import {OPBlob} from "./OPBlob.sol";

/// @notice The first batch of a channel that starts in a batcher's blob: from the blob's first field
///         elements, through frame 0 and brotli, to the batch prefix (docs/op-batch-inbox.md).
/// @dev Mirrors blobDataPrefix, channelStart and decodeBatchPrefix in packages/shared/src/op-batch.ts.
library OPBatchInbox {
    error NotChannelStart();

    uint256 constant CHANNEL_VERSION_BROTLI = 1;
    /// @dev decompressed bytes to read: enough for a singular batch's prefix (a span batch's is shorter)
    uint256 constant PREFIX_BYTES = 112;

    function readBatch(bytes32 versionedHash, bytes memory commitment, bytes memory fieldElements, bytes[] memory proofs)
        internal
        view
        returns (bytes16 channelId, OPBatchPrefix.Batch memory batch)
    {
        OPBlob.verify(versionedHash, commitment, fieldElements, proofs);
        bytes memory compressed;
        (channelId, compressed) = channelStart(OPBlob.data(fieldElements));
        batch = OPBatchPrefix.decode(BrotliPrefix.decode(compressed, PREFIX_BYTES));
    }

    /// @notice Batcher data that starts a channel: derivation version 0, then frame 0 of a brotli
    ///         channel. Returns the brotli stream (as much as `data` has).
    function channelStart(bytes memory data) internal pure returns (bytes16 channelId, bytes memory compressed) {
        if (data.length < 24 || data[0] != 0) revert NotChannelStart();
        uint256 head;
        assembly ("memory-safe") {
            head := mload(add(data, 33)) // channel id (16), frame number (2), frame length (4), version (1)
        }
        channelId = bytes16(bytes32(head));
        if ((head >> 112) & 0xffff != 0) revert NotChannelStart(); // frame number
        uint256 frameLength = (head >> 80) & 0xffffffff;
        if ((head >> 72) & 0xff != CHANNEL_VERSION_BROTLI) revert NotChannelStart();
        uint256 end = 23 + frameLength;
        if (end > data.length) end = data.length;
        uint256 len = end > 24 ? end - 24 : 0;
        compressed = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(compressed, 32), add(data, 56), len)
        }
    }
}
