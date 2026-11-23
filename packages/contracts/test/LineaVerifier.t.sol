// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {LineaVerifier, ILineaRollup} from "../src/linea/LineaVerifier.sol";
import {LineaTrie} from "../src/linea/LineaTrie.sol";
import {Poseidon2} from "../src/lib/linea/Poseidon2.sol";
import {L2ReverseResolver, NameProof} from "../src/L2ReverseResolver.sol";
import {MockLineaRollup} from "./mocks/MockLinea.sol";

contract TrieHarness {
    function verifyAndFind(bytes32 root, bytes32 hKey, LineaTrie.MultiProof memory p)
        external
        pure
        returns (bool found, uint256 pos)
    {
        LineaTrie.verifyLeaves(root, p);
        return LineaTrie.find(p, hKey);
    }

    function hash(bytes memory v) external pure returns (bytes32) {
        return Poseidon2.hash(v);
    }
}

/// @dev Real linea_getProof output from mainnet (scripts/linea-fixture.ts), converted to multiproofs.
contract LineaVerifierTest is Test {
    uint256 constant MAX_BLOCK_LAG = 1000;
    uint256 constant DEPTH = 40;

    // one linea_getProof path
    struct Path {
        uint256 index;
        bytes top;
        bytes leaf;
        bytes value;
        bytes32[] siblings; // bottom -> top
    }

    string json;
    MockLineaRollup rollup;
    LineaVerifier verifier;
    L2ReverseResolver resolver;
    uint256 l2Block;
    address registrar;

    function setUp() public {
        json = vm.readFile("test/fixtures/linea.json");
        l2Block = vm.parseJsonUint(json, ".l2Block");
        registrar = vm.parseJsonAddress(json, ".registrar");
        rollup = new MockLineaRollup();
        rollup.finalize(l2Block, vm.parseJsonBytes32(json, ".stateRoot"));
        verifier = new LineaVerifier(ILineaRollup(address(rollup)), MAX_BLOCK_LAG);
        resolver = new L2ReverseResolver(verifier, registrar, 0, 0x8000e708, new string[](0));
    }

    // -- fixture => multiproof (what the indexer/gateway do in TypeScript)

    function _path(string memory index, string memory proof, bool withValue) internal view returns (Path memory p) {
        p.index = vm.parseJsonUint(json, index);
        bytes[] memory nodes = vm.parseJsonBytesArray(json, string.concat(proof, ".proofRelatedNodes"));
        p.top = nodes[0];
        p.leaf = nodes[DEPTH + 1];
        if (withValue) p.value = vm.parseJsonBytes(json, string.concat(proof, ".value"));
        p.siblings = new bytes32[](DEPTH);
        for (uint256 level; level < DEPTH; ++level) {
            bytes memory node = nodes[DEPTH - level];
            p.siblings[level] = level == 0 && node.length == 32 ? bytes32(node) : Poseidon2.hash(node);
        }
    }

    function _inclusion(string memory key) internal view returns (Path memory) {
        return _path(string.concat(key, ".leafIndex"), string.concat(key, ".proof"), true);
    }

    function _left(string memory key) internal view returns (Path memory) {
        return _path(string.concat(key, ".leftLeafIndex"), string.concat(key, ".leftProof"), false);
    }

    function _right(string memory key) internal view returns (Path memory) {
        return _path(string.concat(key, ".rightLeafIndex"), string.concat(key, ".rightProof"), false);
    }

    function _multi(Path[] memory paths) internal pure returns (LineaTrie.MultiProof memory p) {
        // sort by index
        for (uint256 i = 1; i < paths.length; ++i) {
            for (uint256 j = i; j > 0 && paths[j - 1].index > paths[j].index; --j) {
                (paths[j - 1], paths[j]) = (paths[j], paths[j - 1]);
            }
        }
        uint256 k = paths.length;
        p.top = paths[0].top;
        p.indices = new uint256[](k);
        p.leaves = new bytes[](k);
        p.values = new bytes[](k);
        uint256[] memory idx = new uint256[](k);
        uint256[] memory src = new uint256[](k); // a path through each current node
        for (uint256 i; i < k; ++i) {
            p.indices[i] = idx[i] = paths[i].index;
            p.leaves[i] = paths[i].leaf;
            p.values[i] = paths[i].value;
            src[i] = i;
        }
        bytes32[] memory siblings = new bytes32[](DEPTH * k);
        uint256 s;
        for (uint256 level; level < DEPTH; ++level) {
            uint256 n;
            for (uint256 i; i < k; ++n) {
                uint256 index = idx[i];
                uint256 from = src[i];
                if (index & 1 == 0 && i + 1 < k && idx[i + 1] == index + 1) {
                    i += 2;
                } else {
                    siblings[s++] = paths[from].siblings[level];
                    i += 1;
                }
                idx[n] = index >> 1;
                src[n] = from;
            }
            k = n;
        }
        assembly {
            mstore(siblings, s)
        }
        p.siblings = siblings;
    }

    function _one(Path memory a) internal pure returns (LineaTrie.MultiProof memory) {
        Path[] memory v = new Path[](1);
        v[0] = a;
        return _multi(v);
    }

    function _two(Path memory a, Path memory b) internal pure returns (LineaTrie.MultiProof memory) {
        Path[] memory v = new Path[](2);
        v[0] = a;
        v[1] = b;
        return _multi(v);
    }

    function _slots(uint256 a) internal pure returns (uint256[] memory v) {
        v = new uint256[](1);
        v[0] = a;
    }

    // -- account

    function _accountProof() internal view returns (bytes memory) {
        return abi.encode(_one(_inclusion(".accountProof")));
    }

    function _storageRoot() internal view returns (bytes32) {
        return verifier.verifyStorageRoot(abi.encode(l2Block), registrar, _accountProof());
    }

    function test_storageRoot() public view {
        bytes memory account = vm.parseJsonBytes(json, ".accountProof.proof.value");
        bytes32 expected;
        assembly {
            expected := mload(add(account, 96))
        }
        assertEq(_storageRoot(), expected);
    }

    function test_wrongAccount() public {
        bytes memory proof = _accountProof();
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageRoot(abi.encode(l2Block), address(1), proof);
    }

    function test_tamperedAccount() public {
        LineaTrie.MultiProof memory p = _one(_inclusion(".accountProof"));
        p.values[0][95] ^= 0x01; // storage root
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageRoot(abi.encode(l2Block), registrar, abi.encode(p));
    }

    function test_notFinalized() public {
        bytes memory proof = _accountProof();
        vm.expectRevert(abi.encodeWithSelector(LineaVerifier.NotFinalized.selector, l2Block - 1));
        verifier.verifyStorageRoot(abi.encode(l2Block - 1), registrar, proof);
    }

    function test_stale() public {
        bytes memory proof = _accountProof();
        rollup.finalize(l2Block + MAX_BLOCK_LAG + 1, keccak256("later"));
        vm.expectRevert(abi.encodeWithSelector(LineaVerifier.StaleCommit.selector, l2Block, l2Block + MAX_BLOCK_LAG + 1));
        verifier.verifyStorageRoot(abi.encode(l2Block), registrar, proof);
    }

    // -- storage

    function test_inclusion() public view {
        bytes32[] memory values = verifier.verifyStorageValues(
            _storageRoot(), _slots(vm.parseJsonUint(json, ".short.slot")), abi.encode(_one(_inclusion(".short.proof")))
        );
        assertEq(values[0], vm.parseJsonBytes32(json, ".short.proof.proof.value"));
    }

    function test_inclusionWrongValue() public {
        LineaTrie.MultiProof memory p = _one(_inclusion(".short.proof"));
        p.values[0][0] ^= 0x01;
        bytes32 root = _storageRoot();
        uint256[] memory slots = _slots(vm.parseJsonUint(json, ".short.slot"));
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageValues(root, slots, abi.encode(p));
    }

    function test_inclusionWrongSlot() public {
        bytes32 root = _storageRoot();
        uint256[] memory slots = _slots(vm.parseJsonUint(json, ".unset.slot"));
        bytes memory proof = abi.encode(_one(_inclusion(".short.proof")));
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageValues(root, slots, proof);
    }

    function test_wrongSibling() public {
        LineaTrie.MultiProof memory p = _one(_inclusion(".short.proof"));
        p.siblings[3] ^= bytes32(uint256(1));
        bytes32 root = _storageRoot();
        uint256[] memory slots = _slots(vm.parseJsonUint(json, ".short.slot"));
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageValues(root, slots, abi.encode(p));
    }

    function test_exclusion() public view {
        bytes32[] memory values = verifier.verifyStorageValues(
            _storageRoot(),
            _slots(vm.parseJsonUint(json, ".unset.slot")),
            abi.encode(_two(_left(".unset.proof"), _right(".unset.proof")))
        );
        assertEq(values[0], 0);
    }

    function test_exclusionOfPresentSlot() public {
        // the unset slot's neighbours don't bracket the short name's slot
        bytes32 root = _storageRoot();
        uint256[] memory slots = _slots(vm.parseJsonUint(json, ".short.slot"));
        bytes memory proof = abi.encode(_two(_left(".unset.proof"), _right(".unset.proof")));
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageValues(root, slots, proof);
    }

    // Poseidon2 reduces input limbs mod p, so a leaf whose hKey has a limb + p hashes the same.
    // Without the canonical check, (left, right') would "exclude" right's own key.
    function test_exclusionAliasedKey() public {
        TrieHarness h = new TrieHarness();
        bytes32 root = _storageRoot();
        Path memory right = _right(".unset.proof");
        bytes memory leaf = right.leaf;
        bytes32 hKey;
        assembly {
            hKey := mload(add(leaf, 160)) // word 4
        }
        bytes memory aliased = bytes.concat(leaf);
        assembly {
            let ptr := add(aliased, 160)
            mstore(ptr, add(mload(ptr), 2130706433)) // low limb + p (no carry: limb < p)
        }
        assertEq(h.hash(aliased), h.hash(leaf), "aliasing");
        right.leaf = aliased;
        LineaTrie.MultiProof memory p = _two(_left(".unset.proof"), right);
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        h.verifyAndFind(root, hKey, p);
    }

    function test_unsortedIndices() public {
        LineaTrie.MultiProof memory p = _two(_left(".unset.proof"), _right(".unset.proof"));
        (p.indices[0], p.indices[1]) = (p.indices[1], p.indices[0]);
        bytes32 root = _storageRoot();
        uint256[] memory slots = _slots(vm.parseJsonUint(json, ".unset.slot"));
        vm.expectRevert(LineaTrie.InvalidProof.selector);
        verifier.verifyStorageValues(root, slots, abi.encode(p));
    }

    // -- resolver

    function _nameProof(uint256 dataSlots, LineaTrie.MultiProof memory p) internal view returns (bytes memory) {
        return abi.encode(NameProof(abi.encode(l2Block), _accountProof(), dataSlots, abi.encode(p)));
    }

    function _longProof() internal view returns (LineaTrie.MultiProof memory) {
        Path[] memory v = new Path[](3);
        v[0] = _inclusion(".long.proof");
        v[1] = _inclusion(".long.data[0]");
        v[2] = _inclusion(".long.data[1]");
        return _multi(v);
    }

    function test_resolveShort() public view {
        bytes memory proof = _nameProof(0, _one(_inclusion(".short.proof")));
        uint256 g = gasleft();
        string memory name = resolver.verifyName(vm.parseJsonAddress(json, ".short.addr"), proof);
        console.log("verifyName (short) gas:", g - gasleft());
        assertEq(bytes(name), vm.parseJsonBytes(json, ".short.name"));
    }

    function test_resolveLong() public view {
        bytes memory proof = _nameProof(2, _longProof());
        uint256 g = gasleft();
        string memory name = resolver.verifyName(vm.parseJsonAddress(json, ".long.addr"), proof);
        console.log("verifyName (long, 2 data slots) gas:", g - gasleft());
        assertEq(bytes(name), vm.parseJsonBytes(json, ".long.name"));
    }

    function test_resolveLongWrongCount() public {
        bytes memory proof = _nameProof(1, _longProof());
        address addr = vm.parseJsonAddress(json, ".long.addr");
        vm.expectRevert(L2ReverseResolver.InvalidStorageProofs.selector);
        resolver.verifyName(addr, proof);
    }

    function test_resolveUnset() public view {
        bytes memory proof = _nameProof(0, _two(_left(".unset.proof"), _right(".unset.proof")));
        uint256 g = gasleft();
        string memory name = resolver.verifyName(vm.parseJsonAddress(json, ".unset.addr"), proof);
        console.log("verifyName (unset) gas:", g - gasleft());
        assertEq(bytes(name).length, 0);
    }
}
