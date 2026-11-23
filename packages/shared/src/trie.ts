// Merkle-Patricia tries as rows: every node at its absolute nibble path, as its RLP encoding
// (merkle-builder's row format, see EthRowStorage). Every encoding already contains its
// children's hashes, so a gateway can store rows and serve eth_getProof-style proofs by
// walking paths and copying encodings: no trie in memory and no hashing.

import { getProofFromRows, type RowReader } from "@ensdomains/merkle-builder";
import { type Hex, hexToBytes, keccak256 } from "viem";

// node: RLP encoding, or null when the node at this path was removed
export type { RowReader, TrieRow } from "@ensdomains/merkle-builder";

// storage hash from the root row (empty trie: keccak(0x80))
export function rootHash(rootNode: Uint8Array | undefined): Hex {
	return keccak256(rootNode ?? new Uint8Array([0x80]));
}

// eth_getProof storage proof for `slot` by walking rows (same nodes as merkle-builder's getProof)
// value: the trimmed big-endian word (empty if unset)
export function proveSlot(get: RowReader, slot: Uint8Array): { proof: Hex[]; value: Uint8Array } {
	return getProofFromRows(get, slot);
}

export function rowBytes(node: Hex | null): Uint8Array | null {
	return node === null ? null : hexToBytes(node);
}
