// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {EigenDABlob} from "../../src/eigen/EigenDABlob.sol";

contract EigenDABlobHarness {
    function verify(uint256 x, uint256 y, uint256 length, bytes memory evaluations, bytes memory proof)
        external
        view
        returns (uint256 gasUsed)
    {
        uint256 g = gasleft();
        EigenDABlob.verify(EigenDABlob.G1(x, y), length, evaluations, proof);
        return g - gasleft();
    }
}
