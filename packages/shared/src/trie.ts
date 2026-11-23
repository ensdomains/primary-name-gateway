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

// Chunks: what the indexer serves and the gateway stores, instead of one row per node. A node at a
// path shorter than CHUNK_DEPTH nibbles is its own row (the trunk); every deeper node is in the row
// of its CHUNK_DEPTH-nibble prefix (a limb). On Base (5.08M nodes) that's ~70k rows of ~6 KB, and a
// proof reads CHUNK_DEPTH trunk rows and one limb.
//
// A limb is its nodes in path order, each: u8 suffix length (nibbles) . suffix (packed, high nibble
// first, odd lengths padded with 0) . u16 node length . node. An empty limb is a removed row.
export const CHUNK_DEPTH = 4;
// what /snapshot and /patch serve (x-row-format)
export const ROW_FORMAT_MPT = "mpt-chunks-4";
export const ROW_FORMAT_LINEA = "linea";

export function chunkId(path: string): string {
	return path.length < CHUNK_DEPTH ? path : path.slice(0, CHUNK_DEPTH);
}

const HEX = "0123456789abcdef";

// the first path after every path that starts with `prefix` (undefined: there is none)
export function nextPrefix(prefix: string): string | undefined {
	let i = prefix.length - 1;
	while (i >= 0 && prefix[i] === "f") i--;
	if (i < 0) return;
	return prefix.slice(0, i) + HEX[HEX.indexOf(prefix[i]) + 1];
}

export function encodeLimb(nodes: { suffix: string; node: Uint8Array }[]): Uint8Array {
	let size = 0;
	for (const { suffix, node } of nodes) size += 3 + ((suffix.length + 1) >> 1) + node.length;
	const out = new Uint8Array(size);
	let pos = 0;
	for (const { suffix, node } of nodes) {
		if (suffix.length > 255 || node.length > 0xffff) throw new Error("limb entry too large");
		out[pos++] = suffix.length;
		for (let i = 0; i < suffix.length; i += 2) {
			out[pos++] = (HEX.indexOf(suffix[i]) << 4) | (i + 1 < suffix.length ? HEX.indexOf(suffix[i + 1]) : 0);
		}
		out[pos++] = node.length >> 8;
		out[pos++] = node.length & 0xff;
		out.set(node, pos);
		pos += node.length;
	}
	return out;
}

export function decodeLimb(limb: Uint8Array): { suffix: string; node: Uint8Array }[] {
	const out: { suffix: string; node: Uint8Array }[] = [];
	for (let pos = 0; pos < limb.length; ) {
		const n = limb[pos++];
		let suffix = "";
		for (let i = 0; i < n; i += 2) {
			const b = limb[pos++];
			suffix += HEX[b >> 4];
			if (i + 1 < n) suffix += HEX[b & 15];
		}
		const len = (limb[pos] << 8) | limb[pos + 1];
		pos += 2;
		if (pos + len > limb.length) throw new Error("truncated limb");
		out.push({ suffix, node: limb.subarray(pos, pos + len) });
		pos += len;
	}
	return out;
}

// a RowReader over chunk rows; each limb is read and decoded once per reader
export function chunkReader(get: (id: string) => Uint8Array | undefined): RowReader {
	const limbs = new Map<string, Map<string, Uint8Array>>();
	return (path) => {
		if (path.length < CHUNK_DEPTH) return get(path);
		const id = path.slice(0, CHUNK_DEPTH);
		let limb = limbs.get(id);
		if (!limb) {
			const row = get(id);
			limb = new Map(row ? decodeLimb(row).map((x) => [x.suffix, x.node]) : []);
			limbs.set(id, limb);
		}
		return limb.get(path.slice(CHUNK_DEPTH));
	};
}
