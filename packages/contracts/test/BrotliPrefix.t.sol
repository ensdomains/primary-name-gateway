// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {BrotliPrefix} from "../src/brotli/BrotliPrefix.sol";

// Real batcher frames (2026-11-23): channel version byte (0x01 = brotli), then the brotli stream.
// test/brotli-sol.test.ts checks BrotliPrefix against the TypeScript reference; these are for gas.
contract BrotliPrefixTest is Test {
    function _stream(string memory name) internal view returns (bytes memory s) {
        bytes memory frame = vm.readFileBinary(string.concat("test/fixtures/op-batch/", name, "-frame0.bin"));
        assertEq(uint8(frame[0]), 1);
        s = new bytes(frame.length - 1);
        assembly ("memory-safe") {
            mcopy(add(s, 32), add(frame, 33), mload(s))
        }
    }

    // the batch is an RLP string: its type byte follows the long-string header
    function _batchType(bytes memory out) internal pure returns (uint256) {
        return 1 + uint8(out[0]) - 0xb7;
    }

    function test_op() external view {
        bytes memory out = BrotliPrefix.decode(_stream("op"), 64);
        assertEq(out.length, 64);
        assertEq(uint8(out[_batchType(out)]), 1); // span batch
    }

    function test_base() external view {
        bytes memory out = BrotliPrefix.decode(_stream("base"), 112);
        assertEq(out.length, 112);
        assertEq(uint8(out[_batchType(out)]), 0); // singular batch
    }
}
