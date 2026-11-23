// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";

/// @dev Subset of OP's AnchorStateRegistry (v4+).
interface IAnchorStateRegistry {
    function isGameClaimValid(address game) external view returns (bool);
    function getAnchorRoot() external view returns (bytes32 root, uint256 l2SequenceNumber);
}

/// @dev Subset of OP's IDisputeGame.
interface IDisputeGame {
    function rootClaim() external view returns (bytes32);
    function l2SequenceNumber() external view returns (uint256);
}

/// @notice OP Stack `Types.OutputRootProof`.
struct OutputRootProof {
    bytes32 version;
    bytes32 stateRoot;
    bytes32 messagePasserStorageRoot;
    bytes32 latestBlockhash;
}

/// @notice `commitProof` for `OPFaultVerifier`.
struct OPFaultCommitProof {
    address game; // dispute game whose root claim commits to the L2 state
    bytes superRoot; // super root preimage (empty when the game's root claim is an output root)
    OutputRootProof outputRootProof; // preimage of the L2 output root
}

/// @title OPFaultVerifier
/// @notice Verifies OP Stack L2 storage against a finalized dispute game on L1.
///         Supports both output root games and super root games (interop).
/// @dev Deploy one per chain: (AnchorStateRegistry, L2 chain id).
///      1. `game` is a valid, finalized claim according to the AnchorStateRegistry
///      2. `game` is not older than the current anchor by more than `window` (freshness)
///      3. rootClaim = keccak(superRoot) and superRoot has (l2ChainId => outputRoot), or rootClaim = outputRoot
///      4. outputRoot = keccak(outputRootProof)
///      5. account proof: stateRoot => storageRoot
contract OPFaultVerifier is IL2StorageVerifier {
    error InvalidGame(address game);
    error StaleGame(uint256 l2SequenceNumber, uint256 anchorSequenceNumber);
    error InvalidSuperRoot();
    error ChainNotInSuperRoot(uint256 chainId);
    error InvalidOutputRoot();
    error InvalidStorageProof();

    bytes1 constant SUPER_ROOT_VERSION = 0x01;

    IAnchorStateRegistry public immutable anchorStateRegistry;
    uint256 public immutable l2ChainId;
    /// @notice Max lag of a game behind the current anchor, in L2 sequence units
    ///         (timestamp for super root games, block number for output root games).
    uint256 public immutable window;

    constructor(IAnchorStateRegistry anchorStateRegistry_, uint256 l2ChainId_, uint256 window_) {
        anchorStateRegistry = anchorStateRegistry_;
        l2ChainId = l2ChainId_;
        window = window_;
    }

    /// @dev `accountProof` = abi.encode(bytes[]) (eth_getProof accountProof)
    function verifyStorageRoot(bytes calldata commitProof, address target, bytes calldata accountProof)
        external
        view
        returns (bytes32)
    {
        bytes32 stateRoot = verifyStateRoot(abi.decode(commitProof, (OPFaultCommitProof)));
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

    /// @notice Verify `p` against L1 and return the committed L2 state root.
    function verifyStateRoot(OPFaultCommitProof memory p) public view returns (bytes32) {
        if (!anchorStateRegistry.isGameClaimValid(p.game)) revert InvalidGame(p.game);
        IDisputeGame game = IDisputeGame(p.game);
        uint256 seq = game.l2SequenceNumber();
        (, uint256 anchorSeq) = anchorStateRegistry.getAnchorRoot();
        if (seq + window < anchorSeq) revert StaleGame(seq, anchorSeq);
        bytes32 rootClaim = game.rootClaim();
        bytes32 outputRoot = p.superRoot.length == 0 ? rootClaim : findOutputRoot(p.superRoot, rootClaim);
        if (keccak256(abi.encode(p.outputRootProof)) != outputRoot) revert InvalidOutputRoot();
        return p.outputRootProof.stateRoot;
    }

    /// @dev SuperRootV1 = version(1) . timestamp(8) . [chainId(32) . outputRoot(32)]*
    function findOutputRoot(bytes memory superRoot, bytes32 rootClaim) public view returns (bytes32 outputRoot) {
        uint256 n = superRoot.length;
        if (keccak256(superRoot) != rootClaim || n < 9 || (n - 9) % 64 != 0 || superRoot[0] != SUPER_ROOT_VERSION) {
            revert InvalidSuperRoot();
        }
        uint256 chainId = l2ChainId;
        for (uint256 pos = 9; pos < n; pos += 64) {
            uint256 id;
            assembly ("memory-safe") {
                let ptr := add(add(superRoot, 32), pos)
                id := mload(ptr)
                outputRoot := mload(add(ptr, 32))
            }
            if (id == chainId) return outputRoot;
        }
        revert ChainNotInSuperRoot(chainId);
    }
}
