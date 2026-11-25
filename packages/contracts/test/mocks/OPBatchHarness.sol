// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {OPBatchInbox} from "../../src/op/OPBatchInbox.sol";
import {OPBatchPrefix} from "../../src/op/OPBatchPrefix.sol";
import {OPBlob} from "../../src/op/OPBlob.sol";

contract OPBatchHarness {
    function batch(bytes memory data) external pure returns (OPBatchPrefix.Batch memory) {
        return OPBatchPrefix.decode(data);
    }

    function blobData(bytes memory fieldElements) external pure returns (bytes memory) {
        return OPBlob.data(fieldElements);
    }

    function verifyBlob(bytes32 versionedHash, bytes memory commitment, bytes memory fieldElements, bytes memory proof)
        external
        view
        returns (uint256 gasUsed)
    {
        uint256 g = gasleft();
        OPBlob.verify(versionedHash, commitment, fieldElements, proof);
        return g - gasleft();
    }

    function readBatch(bytes32 versionedHash, bytes memory commitment, bytes memory fieldElements, bytes memory proof)
        external
        view
        returns (bytes16 channelId, OPBatchPrefix.Batch memory b, uint256 gasUsed)
    {
        uint256 g = gasleft();
        (channelId, b) = OPBatchInbox.readBatch(versionedHash, commitment, fieldElements, proof);
        gasUsed = g - gasleft();
    }
}
