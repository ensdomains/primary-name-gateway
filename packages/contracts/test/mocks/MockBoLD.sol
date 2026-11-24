// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AssertionNode, AssertionState, AssertionStatus, IBoLDRollup} from "../../src/arbitrum/ArbitrumVerifier.sol";

// the rest of BoLD's AssertionCreated (nitro-contracts: AssertionState.sol, IRollupCore.sol)
struct ConfigData {
    bytes32 wasmModuleRoot;
    uint256 requiredStake;
    address challengeManager;
    uint64 confirmPeriodBlocks;
    uint64 nextInboxPosition;
}

struct BeforeStateData {
    bytes32 prevPrevAssertionHash;
    bytes32 sequencerBatchAcc;
    ConfigData configData;
}

struct AssertionInputs {
    BeforeStateData beforeStateData;
    AssertionState beforeState;
    AssertionState afterState;
}

/// @dev A BoLD rollup for tests: assertions are created (with BoLD's event and hash), confirmed and
///      challenged on demand, or set directly.
contract MockBoLDRollup is IBoLDRollup {
    event AssertionCreated(
        bytes32 indexed assertionHash,
        bytes32 indexed parentAssertionHash,
        AssertionInputs assertion,
        bytes32 afterInboxBatchAcc,
        uint256 inboxMaxCount,
        bytes32 wasmModuleRoot,
        uint256 requiredStake,
        address challengeManager,
        uint64 confirmPeriodBlocks
    );

    mapping(bytes32 => AssertionNode) nodes;
    bytes32 public latestConfirmed;
    uint64 public confirmPeriodBlocks = 20;

    function setAssertion(bytes32 assertionHash, AssertionNode memory node) external {
        nodes[assertionHash] = node;
    }

    function setLatestConfirmed(bytes32 assertionHash) external {
        latestConfirmed = assertionHash;
    }

    function getAssertion(bytes32 assertionHash) external view returns (AssertionNode memory) {
        return nodes[assertionHash];
    }

    // a pending child of `parent`; a second child of the same parent is a rival
    function createAssertion(bytes32 parent, AssertionState calldata afterState, bytes32 afterInboxBatchAcc)
        external
        returns (bytes32 h)
    {
        h = keccak256(abi.encodePacked(parent, keccak256(abi.encode(afterState)), afterInboxBatchAcc));
        AssertionNode storage p = nodes[parent];
        bool first = p.firstChildBlock == 0;
        if (first) p.firstChildBlock = uint64(block.number);
        else p.secondChildBlock = uint64(block.number);
        nodes[h] = AssertionNode(0, 0, uint64(block.number), first, AssertionStatus.Pending, 0);
        AssertionInputs memory a;
        a.afterState = afterState;
        emit AssertionCreated(h, parent, a, afterInboxBatchAcc, 0, 0, 0, address(0), confirmPeriodBlocks);
    }

    function confirm(bytes32 assertionHash) external {
        nodes[assertionHash].status = AssertionStatus.Confirmed;
        latestConfirmed = assertionHash;
    }
}
