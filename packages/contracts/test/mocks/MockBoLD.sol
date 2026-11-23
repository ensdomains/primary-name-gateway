// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AssertionNode, IBoLDRollup} from "../../src/arbitrum/ArbitrumVerifier.sol";

/// @dev A BoLD rollup whose assertions are set directly (tests).
contract MockBoLDRollup is IBoLDRollup {
    mapping(bytes32 => AssertionNode) nodes;
    bytes32 public latestConfirmed;

    function setAssertion(bytes32 assertionHash, AssertionNode memory node) external {
        nodes[assertionHash] = node;
    }

    function setLatestConfirmed(bytes32 assertionHash) external {
        latestConfirmed = assertionHash;
    }

    function getAssertion(bytes32 assertionHash) external view returns (AssertionNode memory) {
        return nodes[assertionHash];
    }
}
