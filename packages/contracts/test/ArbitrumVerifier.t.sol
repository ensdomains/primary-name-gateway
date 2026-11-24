// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {
    ArbitrumCommitProof,
    ArbitrumVerifier,
    AssertionNode,
    AssertionState,
    AssertionStatus,
    GlobalState,
    MachineStatus
} from "../src/arbitrum/ArbitrumVerifier.sol";
import {L2ReverseResolver, NameProof} from "../src/L2ReverseResolver.sol";
import {MockBoLDRollup} from "./mocks/MockBoLD.sol";

/// @dev Real Arbitrum One data (scripts/arbitrum-fixture.ts): the latest confirmed assertion, with its
///      parent as the anchor, and its pending child; the rollup itself is a mock holding their nodes.
contract ArbitrumVerifierTest is Test {
    uint256 constant MIN_AGE = 1800; // 6 hours of L1 blocks
    uint256 constant MAX_AGE = 50_000;
    uint256 constant ARB1_COIN_TYPE = 0x8000a4b1;

    string json;
    MockBoLDRollup rollup;
    address registrar;
    bytes32 anchor;
    bytes32 confirmed;
    bytes32 child;

    function setUp() public {
        json = vm.readFile("test/fixtures/arbitrum.json");
        registrar = vm.parseJsonAddress(json, ".registrar");
        rollup = new MockBoLDRollup();
        anchor = vm.parseJsonBytes32(json, ".confirmed.parent");
        confirmed = vm.parseJsonBytes32(json, ".confirmed.hash");
        child = vm.parseJsonBytes32(json, ".child.hash");
        rollup.setAssertion(anchor, _node(".confirmed.node", AssertionStatus.Confirmed));
        rollup.setAssertion(confirmed, _node(".confirmed.node", AssertionStatus.Confirmed));
        rollup.setAssertion(child, _node(".child.node", AssertionStatus.Pending));
        rollup.setLatestConfirmed(confirmed);
        vm.roll(_createdAt(".child") + MIN_AGE);
    }

    function _node(string memory key, AssertionStatus status) internal view returns (AssertionNode memory n) {
        n.firstChildBlock = uint64(vm.parseJsonUint(json, string.concat(key, ".firstChildBlock")));
        n.secondChildBlock = uint64(vm.parseJsonUint(json, string.concat(key, ".secondChildBlock")));
        n.createdAtBlock = uint64(vm.parseJsonUint(json, string.concat(key, ".createdAtBlock")));
        n.isFirstChild = true;
        n.status = status;
    }

    function _createdAt(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, string.concat(key, ".node.createdAtBlock"));
    }

    function _state(string memory key) internal view returns (AssertionState memory s) {
        bytes32[] memory b = vm.parseJsonBytes32Array(json, string.concat(key, ".afterState.globalState.bytes32Vals"));
        uint256[] memory u = vm.parseJsonUintArray(json, string.concat(key, ".afterState.globalState.u64Vals"));
        s.globalState = GlobalState([b[0], b[1]], [uint64(u[0]), uint64(u[1])]);
        s.machineStatus = MachineStatus(vm.parseJsonUint(json, string.concat(key, ".afterState.machineStatus")));
        s.endHistoryRoot = vm.parseJsonBytes32(json, string.concat(key, ".afterState.endHistoryRoot"));
    }

    function _link(string memory key) internal view returns (bytes32, bytes32) {
        return (
            vm.parseJsonBytes32(json, string.concat(key, ".afterStateHash")),
            vm.parseJsonBytes32(json, string.concat(key, ".afterInboxBatchAcc"))
        );
    }

    // anchor -> confirmed
    function _confirmedProof() internal view returns (ArbitrumCommitProof memory p) {
        p.anchor = anchor;
        p.chain = new bytes32[](2);
        (p.chain[0], p.chain[1]) = _link(".confirmed");
        p.afterState = _state(".confirmed");
        p.l2Header = vm.parseJsonBytes(json, ".confirmed.l2Header");
    }

    // anchor -> confirmed -> child (pending)
    function _childProof() internal view returns (ArbitrumCommitProof memory p) {
        p.anchor = anchor;
        p.chain = new bytes32[](4);
        (p.chain[0], p.chain[1]) = _link(".confirmed");
        (p.chain[2], p.chain[3]) = _link(".child");
        p.afterState = _state(".child");
        p.l2Header = vm.parseJsonBytes(json, ".child.l2Header");
    }

    function _verifier(uint256 minAge) internal returns (ArbitrumVerifier) {
        return new ArbitrumVerifier(rollup, minAge, MAX_AGE);
    }

    function _storageRoot(ArbitrumVerifier v, ArbitrumCommitProof memory p, string memory at)
        internal
        view
        returns (bytes32)
    {
        bytes[] memory account = vm.parseJsonBytesArray(json, string.concat(at, ".accountProof"));
        return v.verifyStorageRoot(abi.encode(p), registrar, abi.encode(account));
    }

    function test_confirmedAssertion_realName() public {
        ArbitrumVerifier v = _verifier(0);
        ArbitrumCommitProof memory p = _confirmedProof();
        assertEq(_storageRoot(v, p, ".atConfirmed"), vm.parseJsonBytes32(json, ".atConfirmed.storageHash"));

        string[] memory urls = new string[](0);
        L2ReverseResolver resolver = new L2ReverseResolver(v, registrar, 0, ARB1_COIN_TYPE, urls);
        bytes[] memory account = vm.parseJsonBytesArray(json, ".atConfirmed.accountProof");
        for (uint256 i; i < 2; ++i) {
            bytes[][] memory slots = new bytes[][](1);
            slots[0] = vm.parseJsonBytesArray(json, string.concat(".atConfirmed.storage[", vm.toString(i), "].proof"));
            NameProof memory np = NameProof(abi.encode(p), abi.encode(account), 0, abi.encode(slots));
            address addr = vm.parseJsonAddress(json, i == 0 ? ".addr" : ".unset");
            assertEq(resolver.verifyName(addr, abi.encode(np)), i == 0 ? vm.parseJsonString(json, ".name") : "");
        }
    }

    function test_pending_rejectedWhenConfirmedOnly() public {
        ArbitrumVerifier v = _verifier(0);
        ArbitrumCommitProof memory p = _childProof();
        vm.expectRevert(abi.encodeWithSelector(ArbitrumVerifier.NotConfirmed.selector, child));
        v.verifyStateRoot(p);
    }

    function test_pending_acceptedAfterMinAge() public {
        ArbitrumVerifier v = _verifier(MIN_AGE);
        assertEq(_storageRoot(v, _childProof(), ".atChild"), vm.parseJsonBytes32(json, ".atChild.storageHash"));
        // confirmed ones too
        assertEq(
            _storageRoot(v, _confirmedProof(), ".atConfirmed"), vm.parseJsonBytes32(json, ".atConfirmed.storageHash")
        );
    }

    function test_pending_tooNew() public {
        ArbitrumVerifier v = _verifier(MIN_AGE);
        vm.roll(block.number - 1);
        vm.expectRevert(
            abi.encodeWithSelector(ArbitrumVerifier.TooNew.selector, _createdAt(".child"), _createdAt(".child") - 1)
        );
        v.verifyStateRoot(_childProof());
    }

    function test_pending_challengedParent() public {
        ArbitrumVerifier v = _verifier(MIN_AGE);
        AssertionNode memory n = _node(".confirmed.node", AssertionStatus.Confirmed);
        n.secondChildBlock = n.firstChildBlock + 10; // a rival child of the confirmed assertion
        rollup.setAssertion(confirmed, n);
        vm.expectRevert(abi.encodeWithSelector(ArbitrumVerifier.Challenged.selector, child));
        v.verifyStateRoot(_childProof());
    }

    function test_unknownAssertion() public {
        ArbitrumVerifier v = _verifier(MIN_AGE);
        ArbitrumCommitProof memory p = _childProof();
        p.chain[3] = bytes32(uint256(p.chain[3]) ^ 1); // another inbox accumulator
        vm.expectRevert(
            abi.encodeWithSelector(ArbitrumVerifier.UnknownAssertion.selector, _hash(confirmed, p.chain[2], p.chain[3]))
        );
        v.verifyStateRoot(p);
    }

    function test_afterState_mustMatchAndBeFinished() public {
        ArbitrumVerifier v = _verifier(0);
        ArbitrumCommitProof memory p = _confirmedProof();
        p.afterState.endHistoryRoot = bytes32(0);
        vm.expectRevert(ArbitrumVerifier.InvalidAfterState.selector);
        v.verifyStateRoot(p);
        p = _confirmedProof();
        p.afterState.machineStatus = MachineStatus.ERRORED;
        vm.expectRevert(ArbitrumVerifier.InvalidAfterState.selector);
        v.verifyStateRoot(p);
    }

    function test_l2Header_mustBeTheNamedBlock() public {
        ArbitrumVerifier v = _verifier(0);
        ArbitrumCommitProof memory p = _confirmedProof();
        p.l2Header = vm.parseJsonBytes(json, ".child.l2Header");
        vm.expectRevert(ArbitrumVerifier.InvalidL2Header.selector);
        v.verifyStateRoot(p);
    }

    function test_tooOld() public {
        ArbitrumVerifier v = new ArbitrumVerifier(rollup, 0, 100);
        // the child gets confirmed: the confirmed assertion is now ~300 L1 blocks behind it
        rollup.setAssertion(child, _node(".child.node", AssertionStatus.Confirmed));
        rollup.setLatestConfirmed(child);
        vm.expectRevert(
            abi.encodeWithSelector(ArbitrumVerifier.TooOld.selector, _createdAt(".confirmed"), _createdAt(".child"))
        );
        v.verifyStateRoot(_confirmedProof());
    }

    function test_anchor_mustBeConfirmed() public {
        ArbitrumVerifier v = _verifier(MIN_AGE);
        ArbitrumCommitProof memory p = _childProof();
        p.anchor = child;
        vm.expectRevert(abi.encodeWithSelector(ArbitrumVerifier.NotConfirmed.selector, child));
        v.verifyStateRoot(p);
    }

    function test_chain_mustBeWhole() public {
        ArbitrumVerifier v = _verifier(0);
        ArbitrumCommitProof memory p = _confirmedProof();
        p.chain = new bytes32[](0);
        vm.expectRevert(ArbitrumVerifier.InvalidChain.selector);
        v.verifyStateRoot(p);
    }

    function _hash(bytes32 parent, bytes32 afterStateHash, bytes32 inboxAcc) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, afterStateHash, inboxAcc));
    }
}
