// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal LineaRollup for tests: finalizations are posted directly.
contract MockLineaRollup {
    event DataFinalizedV3(
        uint256 indexed startBlockNumber,
        uint256 indexed endBlockNumber,
        bytes32 indexed shnarf,
        bytes32 parentStateRootHash,
        bytes32 finalStateRootHash
    );

    mapping(uint256 => bytes32) public stateRootHashes;
    uint256 public currentL2BlockNumber;

    function finalize(uint256 endBlockNumber, bytes32 stateRoot) external {
        require(endBlockNumber > currentL2BlockNumber, "not after current");
        bytes32 parent = stateRootHashes[currentL2BlockNumber];
        emit DataFinalizedV3(currentL2BlockNumber + 1, endBlockNumber, keccak256(abi.encode(stateRoot)), parent, stateRoot);
        stateRootHashes[endBlockNumber] = stateRoot;
        currentL2BlockNumber = endBlockNumber;
    }
}
