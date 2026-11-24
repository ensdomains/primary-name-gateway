// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IL2StorageVerifier} from "../interfaces/IL2StorageVerifier.sol";
import {EthTrie} from "../lib/EthTrie.sol";

/// @dev Subset of OP's AnchorStateRegistry (v3.7+ / v4+).
interface IAnchorStateRegistry {
    function isGameClaimValid(address game) external view returns (bool);
    /// @dev registered, not blacklisted, not retired, not paused
    function isGameProper(address game) external view returns (bool);
    /// @dev of the respected game type when it was created
    function isGameRespected(address game) external view returns (bool);
    function getAnchorRoot() external view returns (bytes32 root, uint256 l2SequenceNumber);
}

/// @dev Subset of OP's IDisputeGame.
interface IDisputeGame {
    function rootClaim() external view returns (bytes32);
    function l2SequenceNumber() external view returns (uint256);
    function gameType() external view returns (uint32);
    function createdAt() external view returns (uint64);
    function status() external view returns (uint8); // 0 IN_PROGRESS, 1 CHALLENGER_WINS, 2 DEFENDER_WINS
}

/// @dev OP's FaultDisputeGame / SuperFaultDisputeGame: the root claim is the only claim until someone challenges.
interface IFaultDisputeGame {
    function claimDataLen() external view returns (uint256);
}

/// @dev Base's AggregateVerifier (game type 621): set when the TEE proof is challenged with a ZK proof.
interface IAggregateVerifier {
    function counteredByIntermediateRootIndexPlusOne() external view returns (uint256);
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
///      1. `game` is a valid, finalized claim according to the AnchorStateRegistry, or (if `minAgeSec > 0`)
///         proper, respected, not lost, and either resolved for the defender or unchallenged for `minAgeSec`
///      2. `game` is not older than the current anchor by more than `maxL2SequenceLag` (freshness)
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
    uint8 constant CHALLENGER_WINS = 1;
    uint8 constant DEFENDER_WINS = 2;
    uint32 constant AGGREGATE_VERIFIER = 621;

    IAnchorStateRegistry public immutable anchorStateRegistry;
    uint256 public immutable l2ChainId;
    /// @notice How far a game's `l2SequenceNumber` may lag behind the anchor's, i.e. how stale a proven
    ///         value may be. Units: seconds for super root games (the sequence number is a timestamp),
    ///         blocks for output root games. Must exceed the time between games plus the gateway's serve delay,
    ///         or a gateway's fallback commit is rejected. The anchor only moves when it is updated, so it
    ///         can trail the newest valid game.
    uint256 public immutable maxL2SequenceLag;
    /// @notice 0: only finalized games (`isGameClaimValid`). Otherwise also accept a game that nobody has
    ///         challenged for this many seconds. That trusts honest challengers to respond within `minAgeSec`:
    ///         an unchallenged fraudulent proposal would be accepted until it is challenged or blacklisted.
    uint256 public immutable minAgeSec;

    constructor(
        IAnchorStateRegistry anchorStateRegistry_,
        uint256 l2ChainId_,
        uint256 maxL2SequenceLag_,
        uint256 minAgeSec_
    ) {
        anchorStateRegistry = anchorStateRegistry_;
        l2ChainId = l2ChainId_;
        maxL2SequenceLag = maxL2SequenceLag_;
        minAgeSec = minAgeSec_;
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
        if (!isGameAcceptable(p.game)) revert InvalidGame(p.game);
        IDisputeGame game = IDisputeGame(p.game);
        uint256 seq = game.l2SequenceNumber();
        (, uint256 anchorSeq) = anchorStateRegistry.getAnchorRoot();
        if (seq + maxL2SequenceLag < anchorSeq) revert StaleGame(seq, anchorSeq);
        bytes32 rootClaim = game.rootClaim();
        bytes32 outputRoot = p.superRoot.length == 0 ? rootClaim : findOutputRoot(p.superRoot, rootClaim);
        if (keccak256(abi.encode(p.outputRootProof)) != outputRoot) revert InvalidOutputRoot();
        return p.outputRootProof.stateRoot;
    }

    /// @notice Whether `game`'s root claim may be used (see `minAgeSec`).
    function isGameAcceptable(address game) public view returns (bool) {
        if (anchorStateRegistry.isGameClaimValid(game)) return true;
        if (minAgeSec == 0) return false;
        if (!anchorStateRegistry.isGameProper(game) || !anchorStateRegistry.isGameRespected(game)) return false;
        IDisputeGame g = IDisputeGame(game);
        uint8 status = g.status();
        if (status == CHALLENGER_WINS) return false;
        if (status == DEFENDER_WINS) return true; // resolved, waiting for the airgap
        if (g.createdAt() + minAgeSec > block.timestamp) return false;
        return _isUnchallenged(g);
    }

    function _isUnchallenged(IDisputeGame g) internal view returns (bool) {
        if (g.gameType() == AGGREGATE_VERIFIER) {
            try IAggregateVerifier(address(g)).counteredByIntermediateRootIndexPlusOne() returns (uint256 n) {
                return n == 0;
            } catch {
                return false;
            }
        }
        try IFaultDisputeGame(address(g)).claimDataLen() returns (uint256 n) {
            return n == 1;
        } catch {
            return false; // unknown game type: only finalized games
        }
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
