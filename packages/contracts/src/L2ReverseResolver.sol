// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IExtendedResolver} from "./interfaces/IExtendedResolver.sol";
import {INameResolver} from "./interfaces/INameResolver.sol";
import {IL2StorageVerifier} from "./interfaces/IL2StorageVerifier.sol";

/// @notice The CCIP-Read gateway interface (see packages/registrar-gateway).
interface IRegistrarGateway {
    /// @return proof ABI-encoded `NameProof`
    function proveName(address addr) external view returns (bytes memory proof);
}

/// @notice Everything needed to go from an L1 commitment to `names[addr]` on the L2.
struct NameProof {
    bytes commitProof; // L1 => L2 state root (verifier-specific)
    bytes accountProof; // state root => registrar account (verifier-specific)
    uint256 dataSlots; // number of data slots of the name (0 for names < 32 bytes)
    bytes storageProof; // storage root => [header slot, ...data slots] (verifier-specific)
}

/// @title L2ReverseResolver
/// @notice ENSIP-19 reverse resolver for one L2: resolves `name()` for `{addr}.{coinType}.reverse`
///         by reading the L2ReverseRegistrar's `mapping(address => string)` (at `namesSlot`) via CCIP-Read,
///         and verifying the storage proofs against L1 with an `IL2StorageVerifier`.
/// @dev See docs/registrar.md for the registrar storage layouts.
contract L2ReverseResolver is IExtendedResolver {
    /// @dev EIP-3668
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error UnsupportedResolverProfile(bytes4 selector);
    error UnreachableName(bytes name);
    error InvalidStorageProofs();

    IL2StorageVerifier public immutable verifier;
    address public immutable registrar;
    /// @notice Storage slot of the registrar's `mapping(address => string) _names`.
    uint256 public immutable namesSlot;
    uint256 public immutable coinType;
    /// @dev keccak256 of DNS-encoded "{coinType:x}.reverse"
    bytes32 immutable _parentHash;

    string[] internal _urls;

    constructor(
        IL2StorageVerifier verifier_,
        address registrar_,
        uint256 namesSlot_,
        uint256 coinType_,
        string[] memory urls_
    ) {
        verifier = verifier_;
        registrar = registrar_;
        namesSlot = namesSlot_;
        coinType = coinType_;
        _urls = urls_;
        bytes memory label = bytes(_toHex(coinType_));
        _parentHash = keccak256(abi.encodePacked(uint8(label.length), label, uint8(7), "reverse", uint8(0)));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IExtendedResolver).interfaceId || interfaceId == 0x01ffc9a7; // ERC-165
    }

    function gatewayURLs() external view returns (string[] memory) {
        return _urls;
    }

    /// @notice ENSIP-10: only `name(bytes32)` for `{addr}.{coinType}.reverse` is supported.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        if (bytes4(data) != INameResolver.name.selector) revert UnsupportedResolverProfile(bytes4(data));
        address addr = parseName(name);
        revert OffchainLookup(
            address(this),
            _urls,
            abi.encodeCall(IRegistrarGateway.proveName, (addr)),
            this.resolveCallback.selector,
            abi.encode(addr)
        );
    }

    /// @dev `response` is the ABI-encoded return of `IRegistrarGateway.proveName()`.
    /// @return ABI-encoded `name()` result
    function resolveCallback(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        address addr = abi.decode(extraData, (address));
        return abi.encode(verifyName(addr, abi.decode(response, (bytes))));
    }

    /// @notice Verify `proof` (ABI-encoded `NameProof`) and return `names[addr]` on the L2.
    function verifyName(address addr, bytes memory proof) public view returns (string memory) {
        NameProof memory p = abi.decode(proof, (NameProof));
        bytes32 storageRoot = verifier.verifyStorageRoot(p.commitProof, registrar, p.accountProof);
        // Solidity `string` layout: header at `slot`, long data at keccak(slot) + i
        uint256 slot = uint256(keccak256(abi.encode(addr, namesSlot)));
        uint256 n = p.dataSlots;
        uint256[] memory slots = new uint256[](n + 1);
        slots[0] = slot;
        uint256 base = uint256(keccak256(abi.encode(slot)));
        for (uint256 i; i < n; ++i) {
            slots[i + 1] = base + i;
        }
        bytes32[] memory values = verifier.verifyStorageValues(storageRoot, slots, p.storageProof);
        if (values.length != n + 1) revert InvalidStorageProofs();
        return string(_decodeBytes(values));
    }

    /// @notice Parse `{addr}.{coinType}.reverse` (DNS-encoded, lowercase hex address).
    function parseName(bytes calldata name) public view returns (address addr) {
        if (name.length < 41 || uint8(name[0]) != 40 || keccak256(name[41:]) != _parentHash) {
            revert UnreachableName(name);
        }
        uint160 x;
        for (uint256 i = 1; i < 41; ++i) {
            uint8 c = uint8(name[i]);
            uint8 nibble;
            if (c >= 0x30 && c <= 0x39) nibble = c - 0x30;
            else if (c >= 0x61 && c <= 0x66) nibble = c - 0x57;
            else revert UnreachableName(name);
            x = (x << 4) | nibble;
        }
        addr = address(x);
    }

    /// @dev Solidity `bytes`/`string` storage layout: [header, ...data words].
    ///      Rejects a proof whose number of data slots doesn't match the header.
    function _decodeBytes(bytes32[] memory values) internal pure returns (bytes memory v) {
        uint256 header = uint256(values[0]);
        uint256 n = values.length - 1;
        if (header & 1 == 0) {
            // short: data in the high bytes, length * 2 in the low byte
            uint256 size = (header & 0xff) >> 1;
            if (size > 31 || n != 0) revert InvalidStorageProofs();
            v = new bytes(size);
            for (uint256 i; i < size; ++i) {
                v[i] = bytes32(header)[i];
            }
        } else {
            // long: length * 2 + 1 in the header
            uint256 size = header >> 1;
            if (size < 32 || n != (size + 31) >> 5) revert InvalidStorageProofs();
            v = new bytes(n << 5);
            for (uint256 i; i < n; ++i) {
                bytes32 word = values[i + 1];
                assembly ("memory-safe") {
                    mstore(add(add(v, 32), shl(5, i)), word)
                }
            }
            assembly ("memory-safe") {
                mstore(v, size)
            }
        }
    }

    function _toHex(uint256 x) internal pure returns (string memory) {
        if (x == 0) return "0";
        uint256 n;
        for (uint256 y = x; y != 0; y >>= 4) ++n;
        bytes memory s = new bytes(n);
        for (uint256 i = n; i > 0; x >>= 4) {
            s[--i] = bytes1(uint8(x & 15) + (x & 15 < 10 ? 48 : 87));
        }
        return string(s);
    }
}
