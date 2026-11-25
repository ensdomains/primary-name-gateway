// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {EigenDAInboxVerifier} from "../../src/eigen/EigenDAInboxVerifier.sol";
import {ISystemConfig} from "../../src/op/OPBatchInboxVerifier.sol";

/// @dev L1 block hashes are set by the test (fixtures are mainnet blocks).
contract EigenDAInboxVerifierHarness is EigenDAInboxVerifier {
    mapping(uint256 => bytes32) public l1BlockHash;

    constructor(ISystemConfig systemConfig, address batchInbox, uint256 maxOriginLag, uint256 maxL1BlockLag)
        EigenDAInboxVerifier(systemConfig, batchInbox, maxOriginLag, maxL1BlockLag)
    {}

    function setL1BlockHash(uint256 n, bytes32 h) external {
        l1BlockHash[n] = h;
    }

    function _l1BlockHash(uint256 n) internal view override returns (bytes32) {
        return l1BlockHash[n];
    }

    function measure(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32 storageRoot, uint256 gasUsed)
    {
        uint256 g = gasleft();
        storageRoot = this.verifyStorageRoot(commitProof, target, accountProof);
        gasUsed = g - gasleft();
    }
}
