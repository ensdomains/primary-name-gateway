// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {BrotliPrefix} from "../../src/brotli/BrotliPrefix.sol";

contract BrotliHarness {
    function decode(bytes memory data, uint256 need) external view returns (bytes memory out, uint256 gasUsed) {
        uint256 g = gasleft();
        out = BrotliPrefix.decode(data, need);
        gasUsed = g - gasleft();
    }
}
