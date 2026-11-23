// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal stand-ins for OP's L1 fault proof contracts, exposing only what
// OPFaultVerifier and registrar-indexer read. Games are made valid explicitly
// (no dispute/resolution/airgap) so a test can drive the "rollup" directly.
// A game has both challenge markers (FaultDisputeGame's claimDataLen and the
// AggregateVerifier's counteredBy...): readers pick one by game type.

contract MockDisputeGame {
    uint32 public immutable gameType;
    bytes32 public immutable rootClaim;
    uint256 public immutable l2SequenceNumber;
    uint64 public immutable createdAt;
    bytes _extraData;
    uint8 public status; // 0 = IN_PROGRESS, 1 = CHALLENGER_WINS, 2 = DEFENDER_WINS
    uint256 public claimDataLen = 1;
    uint256 public counteredByIntermediateRootIndexPlusOne;

    constructor(uint32 gameType_, bytes32 rootClaim_, bytes memory extraData_, uint256 l2SequenceNumber_) {
        gameType = gameType_;
        rootClaim = rootClaim_;
        _extraData = extraData_;
        l2SequenceNumber = l2SequenceNumber_;
        createdAt = uint64(block.timestamp);
    }

    function challenge() external {
        claimDataLen += 1;
        counteredByIntermediateRootIndexPlusOne = 1;
    }

    function extraData() external view returns (bytes memory) {
        return _extraData;
    }

    function setStatus(uint8 status_) external {
        status = status_;
    }
}

contract MockDisputeGameFactory {
    struct Game {
        uint32 gameType;
        uint64 timestamp;
        address proxy;
    }

    Game[] _games;
    mapping(address => bool) public isGame;

    function gameCount() external view returns (uint256) {
        return _games.length;
    }

    function gameAtIndex(uint256 i) external view returns (uint32, uint64, address) {
        Game memory g = _games[i];
        return (g.gameType, g.timestamp, g.proxy);
    }

    function create(uint32 gameType, bytes32 rootClaim, bytes calldata extraData, uint256 l2SequenceNumber)
        external
        returns (address proxy)
    {
        proxy = address(new MockDisputeGame(gameType, rootClaim, extraData, l2SequenceNumber));
        isGame[proxy] = true;
        _games.push(Game(gameType, uint64(block.timestamp), proxy));
    }
}

contract MockAnchorStateRegistry {
    MockDisputeGameFactory public immutable disputeGameFactory;
    uint32 public respectedGameType;
    mapping(address => bool) public isGameClaimValid;
    mapping(address => bool) public isGameBlacklisted;
    bytes32 _anchorRoot;
    uint256 _anchorSeq;

    constructor(uint32 gameType) {
        disputeGameFactory = new MockDisputeGameFactory();
        respectedGameType = gameType;
    }

    function getAnchorRoot() external view returns (bytes32, uint256) {
        return (_anchorRoot, _anchorSeq);
    }

    // resolve + finalize: the game becomes a valid claim and the new anchor
    function finalize(address game) external {
        MockDisputeGame(game).setStatus(2);
        isGameClaimValid[game] = true;
        uint256 seq = MockDisputeGame(game).l2SequenceNumber();
        if (seq > _anchorSeq) {
            _anchorRoot = MockDisputeGame(game).rootClaim();
            _anchorSeq = seq;
        }
    }

    function isGameProper(address game) external view returns (bool) {
        return disputeGameFactory.isGame(game) && !isGameBlacklisted[game];
    }

    function isGameRespected(address game) external view returns (bool) {
        return MockDisputeGame(game).gameType() == respectedGameType;
    }

    function blacklist(address game) external {
        isGameBlacklisted[game] = true;
        isGameClaimValid[game] = false;
    }
}
