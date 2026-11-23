// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {L2ReverseResolver} from "../src/L2ReverseResolver.sol";
import {IL2StorageVerifier} from "../src/interfaces/IL2StorageVerifier.sol";
import {OPFaultVerifier, IAnchorStateRegistry} from "../src/op/OPFaultVerifier.sol";

contract UnitsTest is Test {
    L2ReverseResolver resolver;
    OPFaultVerifier verifier;

    function setUp() public {
        verifier = new OPFaultVerifier(IAnchorStateRegistry(address(0)), 10, 0, 0);
        resolver = new L2ReverseResolver(IL2StorageVerifier(address(verifier)), address(1), 0, 0x8000000a, new string[](0));
    }

    function _dns(string memory addrLabel, string memory parent) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(addrLabel).length), addrLabel, uint8(bytes(parent).length), parent, uint8(7), "reverse", uint8(0));
    }

    function test_parseName() public view {
        address a = resolver.parseName(_dns("51050ec063d393217b436747617ad1c2285aeeee", "8000000a"));
        assertEq(a, 0x51050ec063d393217B436747617aD1C2285Aeeee);
    }

    function test_parseName_wrongCoinType() public {
        bytes memory name = _dns("51050ec063d393217b436747617ad1c2285aeeee", "80002105");
        vm.expectRevert(abi.encodeWithSelector(L2ReverseResolver.UnreachableName.selector, name));
        resolver.parseName(name);
    }

    function test_parseName_uppercase() public {
        bytes memory name = _dns("51050EC063D393217B436747617AD1C2285AEEEE", "8000000a");
        vm.expectRevert(abi.encodeWithSelector(L2ReverseResolver.UnreachableName.selector, name));
        resolver.parseName(name);
    }

    function test_parseName_shortLabel() public {
        bytes memory name = _dns("51050ec063d393217b436747617ad1c2285aeee", "8000000a");
        vm.expectRevert(abi.encodeWithSelector(L2ReverseResolver.UnreachableName.selector, name));
        resolver.parseName(name);
    }

    // OP mainnet game 0x14A4b423fDb994fd869A214b4D012c54b1Fe5889 (super root, chain 10 only)
    bytes constant SUPER_ROOT =
        hex"01000000006b036c1f000000000000000000000000000000000000000000000000000000000000000af3c5a1ebba6966920f13d1d74b5b6c9b5c4f38f67edbbb575968d76dd7f62150";
    bytes32 constant ROOT_CLAIM = 0x97ab346e2cf23ccf04ef1afd40b40ce297a43bbd85c7065890cfc806223f4986;

    function test_findOutputRoot() public view {
        assertEq(
            verifier.findOutputRoot(SUPER_ROOT, ROOT_CLAIM),
            0xf3c5a1ebba6966920f13d1d74b5b6c9b5c4f38f67edbbb575968d76dd7f62150
        );
    }

    function test_findOutputRoot_wrongClaim() public {
        vm.expectRevert(OPFaultVerifier.InvalidSuperRoot.selector);
        verifier.findOutputRoot(SUPER_ROOT, bytes32(0));
    }

    function test_findOutputRoot_missingChain() public {
        OPFaultVerifier base = new OPFaultVerifier(IAnchorStateRegistry(address(0)), 8453, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(OPFaultVerifier.ChainNotInSuperRoot.selector, 8453));
        base.findOutputRoot(SUPER_ROOT, ROOT_CLAIM);
    }
}
