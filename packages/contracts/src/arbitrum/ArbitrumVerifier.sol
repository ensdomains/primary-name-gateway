// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";
import {RLPReader} from "../lib/optimism/RLPReader.sol";

// Subset of Arbitrum's BoLD rollup (nitro-contracts v3: Assertion.sol, AssertionState.sol,
// GlobalState.sol, Machine.sol, IRollupCore.sol). See docs/arbitrum.md.

enum AssertionStatus {
    NoAssertion,
    Pending,
    Confirmed
}

struct AssertionNode {
    uint64 firstChildBlock;
    uint64 secondChildBlock; // nonzero: a rival child exists (a challenge)
    uint64 createdAtBlock; // L1 block
    bool isFirstChild;
    AssertionStatus status;
    bytes32 configHash;
}

struct GlobalState {
    bytes32[2] bytes32Vals; // [L2 block hash, send root]
    uint64[2] u64Vals; // [inbox position, position in message]
}

enum MachineStatus {
    RUNNING,
    FINISHED,
    ERRORED
}

struct AssertionState {
    GlobalState globalState;
    MachineStatus machineStatus;
    bytes32 endHistoryRoot;
}

interface IBoLDRollup {
    function latestConfirmed() external view returns (bytes32);
    function getAssertion(bytes32 assertionHash) external view returns (AssertionNode memory);
}

struct ArbitrumCommitProof {
    bytes32 anchor; // a confirmed assertion
    // (afterStateHash, afterInboxBatchAcc) of each assertion from the anchor's child to the commit's:
    // assertionHash = keccak256(abi.encodePacked(parentHash, afterStateHash, afterInboxBatchAcc))
    bytes32[] chain;
    AssertionState afterState; // the commit assertion's
    bytes l2Header; // RLP header of the L2 block afterState names
}

/// @notice IL2StorageVerifier for Arbitrum (BoLD): the state root of an L2 block named by an assertion.
///         With `minAgeL1Blocks == 0` the assertion must be confirmed (about 6.4 days). Otherwise it may
///         be pending, if it is at least `minAgeL1Blocks` L1 blocks old and no assertion on its way from
///         the last confirmed one has a rival: that trusts an honest validator to challenge in time.
/// @dev After unruggable-gateways' BoLDVerifierLib (MIT).
contract ArbitrumVerifier is IL2StorageVerifier {
    error InvalidChain();
    error NotConfirmed(bytes32 assertionHash);
    error Challenged(bytes32 assertionHash);
    error UnknownAssertion(bytes32 assertionHash);
    error InvalidAfterState();
    error TooNew(uint256 createdAtBlock, uint256 latest);
    error TooOld(uint256 createdAtBlock, uint256 latest);
    error InvalidL2Header();
    error InvalidStorageProof();

    IBoLDRollup public immutable rollup;
    /// @notice 0: confirmed assertions only. Otherwise: unchallenged assertions this many L1 blocks old.
    uint256 public immutable minAgeL1Blocks;
    /// @notice Freshness: an assertion created at most this many L1 blocks before the latest acceptable
    ///         one (the last confirmed, or the newest old enough).
    uint256 public immutable maxAgeL1Blocks;

    constructor(IBoLDRollup rollup_, uint256 minAgeL1Blocks_, uint256 maxAgeL1Blocks_) {
        rollup = rollup_;
        minAgeL1Blocks = minAgeL1Blocks_;
        maxAgeL1Blocks = maxAgeL1Blocks_;
    }

    /// @inheritdoc IL2StorageVerifier
    /// @dev `commitProof` = abi.encode(ArbitrumCommitProof), `accountProof` = abi.encode(bytes[])
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32)
    {
        (bytes32 stateRoot,) = verifyStateRoot(abi.decode(commitProof, (ArbitrumCommitProof)));
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

    /// @notice Verify `p` against the rollup: the L2 state root, and the assertion's L1 block.
    function verifyStateRoot(ArbitrumCommitProof memory p) public view returns (bytes32 stateRoot, uint256 createdAt) {
        (AssertionNode memory node, bytes32 afterStateHash) = _verifyChain(p.anchor, p.chain);
        if (
            keccak256(abi.encode(p.afterState)) != afterStateHash
                || p.afterState.machineStatus != MachineStatus.FINISHED
        ) {
            revert InvalidAfterState();
        }
        createdAt = node.createdAtBlock;
        uint256 latest = minAgeL1Blocks == 0
            ? rollup.getAssertion(rollup.latestConfirmed()).createdAtBlock
            : (block.number > minAgeL1Blocks ? block.number - minAgeL1Blocks : 0);
        if (createdAt > latest) revert TooNew(createdAt, latest);
        if (createdAt + maxAgeL1Blocks < latest) revert TooOld(createdAt, latest);
        if (keccak256(p.l2Header) != p.afterState.globalState.bytes32Vals[0]) revert InvalidL2Header();
        stateRoot = EthTrie.toBytes32(RLPReader.readBytes(RLPReader.readList(p.l2Header)[3]));
    }

    // Walk from the confirmed anchor to the commit's assertion. Each link must exist; a pending one is
    // allowed only with minAgeL1Blocks, and only if its parent has no rival child.
    function _verifyChain(bytes32 h, bytes32[] memory chain)
        internal
        view
        returns (AssertionNode memory node, bytes32 afterStateHash)
    {
        node = rollup.getAssertion(h);
        if (node.status != AssertionStatus.Confirmed) revert NotConfirmed(h);
        if (chain.length == 0 || chain.length % 2 != 0) revert InvalidChain();
        for (uint256 i; i < chain.length; i += 2) {
            bool unchallenged = node.secondChildBlock == 0;
            afterStateHash = chain[i];
            h = keccak256(abi.encodePacked(h, afterStateHash, chain[i + 1]));
            node = rollup.getAssertion(h);
            if (node.status == AssertionStatus.Confirmed) continue;
            if (node.status != AssertionStatus.Pending) revert UnknownAssertion(h);
            if (minAgeL1Blocks == 0) revert NotConfirmed(h);
            if (!unchallenged) revert Challenged(h);
        }
    }
}
