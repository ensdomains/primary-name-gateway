// Trie nodes as rows: (absolute nibble path, RLP encoding).
//
// The indexer owns real merkle-builder tries and turns them into rows (snapshots) and
// row diffs between commits (patches). Every encoding already contains its children's
// hashes, so a gateway can store rows and serve eth_getProof-style proofs by walking
// paths and copying encodings: no trie in memory and no hashing.

import { encodeNode, isBranch, isExtension, type MaybeNode, type Node, toNibblePath } from "@ensdomains/merkle-builder";
import { bytesToHex, fromRlp, type Hex, hexToBytes, keccak256 } from "viem";

// node: RLP encoding, or null when the node at this path was removed
export type TrieRow = { path: string; node: Hex | null };

const NIBBLES = "0123456789abcdef";

export function nibbleString(v: Uint8Array): string {
	let s = "";
	for (const x of v) s += NIBBLES[x];
	return s;
}

// the storage trie key of a slot, as a nibble string
export function slotKey(slot: Uint8Array): string {
	return nibbleString(toNibblePath(keccak256(slot, "bytes")));
}

function* childrenOf(node: Node, path: string): Generator<[string, Node]> {
	if (isBranch(node)) {
		for (let i = 0; i < 16; i++) {
			const child = node.children[i];
			if (child) yield [path + NIBBLES[i], child];
		}
	} else if (isExtension(node)) {
		yield [path + nibbleString(node.path), node.child];
	}
}

function row(path: string, node: Node): TrieRow {
	return { path, node: bytesToHex(encodeNode(node)) };
}

// node that starts exactly at `path`
export function nodeAt(root: MaybeNode, path: string): MaybeNode {
	let node = root;
	let pos = 0;
	while (node) {
		if (pos === path.length) return node;
		if (isBranch(node)) {
			node = node.children[NIBBLES.indexOf(path[pos++])];
		} else if (isExtension(node)) {
			const ext = nibbleString(node.path);
			if (!path.startsWith(ext, pos)) return;
			pos += ext.length;
			node = node.child;
		} else {
			return;
		}
	}
	return;
}

// all nodes in path order (pre-order DFS == lexicographic), strictly after `after` if given
export function* trieRows(root: MaybeNode, after?: string): Generator<TrieRow> {
	function* walk(node: Node, path: string): Generator<TrieRow> {
		// every path in this subtree is < after
		if (after !== undefined && path < after && !after.startsWith(path)) return;
		if (after === undefined || path > after) yield row(path, node);
		for (const [p, c] of childrenOf(node, path)) yield* walk(c, p);
	}
	if (root) yield* walk(root, "");
}

// rows that turn `prev` into `next`
// merkle-builder tries are copy-on-write: an unchanged subtree is the same object at the same path
export function diffRows(prev: MaybeNode, next: MaybeNode): TrieRow[] {
	const rows: TrieRow[] = [];
	function upsert(node: Node, path: string) {
		if (nodeAt(prev, path) === node) return;
		rows.push(row(path, node));
		for (const [p, c] of childrenOf(node, path)) upsert(c, p);
	}
	function remove(node: Node, path: string) {
		const replacement = nodeAt(next, path);
		if (replacement === node) return;
		if (!replacement) rows.push({ path, node: null });
		for (const [p, c] of childrenOf(node, path)) remove(c, p);
	}
	if (next) upsert(next, "");
	if (prev) remove(prev, "");
	return rows;
}

// storage hash from the root row (empty trie: keccak(0x80))
export function rootHash(rootNode: Uint8Array | undefined): Hex {
	return keccak256(rootNode ?? new Uint8Array([0x80]));
}

export type RowReader = (path: string) => Uint8Array | undefined;

// eth_getProof storage proof for `slot` by walking rows (same nodes as merkle-builder's getProof)
// value: the trimmed big-endian word (empty if unset)
export function proveSlot(get: RowReader, slot: Uint8Array): { proof: Hex[]; value: Uint8Array } {
	const key = slotKey(slot);
	const proof: Hex[] = [];
	let value: Uint8Array = new Uint8Array(0);
	let path = "";
	for (;;) {
		const encoded = get(path);
		if (!encoded) break;
		proof.push(bytesToHex(encoded));
		const items = fromRlp(encoded, "bytes") as (Uint8Array | unknown[])[];
		if (items.length === 17) {
			if (path.length === key.length) break;
			const nibble = key[path.length];
			const child = items[NIBBLES.indexOf(nibble)];
			if (child instanceof Uint8Array && !child.length) break;
			path += nibble;
		} else if (items.length === 2) {
			const [compact, data] = items as [Uint8Array, Uint8Array];
			const flag = compact[0] >> 4;
			const nibbles = (flag & 1 ? NIBBLES[compact[0] & 15] : "") + nibbleString(toNibblePath(compact.subarray(1)));
			const rest = key.slice(path.length);
			if (flag >= 2) {
				// leaf: [path, rlp(value)]
				if (rest === nibbles) value = fromRlp(data, "bytes") as Uint8Array;
				break;
			}
			if (!rest.startsWith(nibbles)) break;
			path += nibbles;
		} else {
			throw new Error(`invalid node at ${path || "<root>"}`);
		}
	}
	return { proof, value };
}

export function rowBytes(node: Hex | null): Uint8Array | null {
	return node === null ? null : hexToBytes(node);
}
