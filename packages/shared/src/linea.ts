// Linea (Shomei) sparse Merkle tries as rows, and multiproofs for LineaVerifier.
//
// Trie (same for the world state and contract storage):
//   * binary tree of depth 40, leaves in insertion order (indices never reused)
//   * leaves form a linked list sorted by hkey between HEAD (#0) and TAIL (#1)
//   * root = H(pad(nextFreeIndex) . subRoot), leaf = pad(prev) . pad(next) . hkey . hval
//   * storage: hkey = H(pad(slot)), hval = H(pad(value)); new slots of a block are inserted in hkey order
//
// Rows (what the indexer serves and the gateway stores):
//   "r"                 root preimage: pad(nextFreeIndex) . subRoot (96 bytes)
//   "h{level:02x}{i:x}" hash of node i at level 0..39 (level 0 = leaf hash); absent = empty subtree
//   "l{i:x}"            leaf (192 bytes) . raw value
//   "k{hkey}"           leaf index (8 bytes), sorted by hkey: an exclusion proof needs the
//                       greatest key below the missing one
//
// Proofs only copy rows: the gateway hashes slot keys and nothing else.
// https://github.com/Consensys/shomei/blob/main/trie/src/main/java/net/consensys/shomei/trie/ZKTrie.java

import {
	EMPTY_BYTES,
	LINEA_TREE_DEPTH,
	lineaHashKey,
	lineaHashValue,
	poseidon2,
	poseidon2Pad,
	SlotStorage,
	toWord,
	trimLeadingZeros,
} from "@ensdomains/merkle-builder";
import { bytesToHex, concat, encodeAbiParameters, type Hex, hexToBytes, numberToBytes } from "viem";
import type { TrieRow } from "./trie.js";

export const LINEA_DEPTH = LINEA_TREE_DEPTH;
export const LINEA_ROOT_PATH = "r";
export const LINEA_KEY_PREFIX = "k";

const HEAD_INDEX = 0;
const TAIL_INDEX = 1;
const HEAD_HKEY = new Uint8Array(32);
const TAIL_HKEY = Uint8Array.from({ length: 32 }, (_, i) => (i & 3 ? 0 : 0x7f));
const ZERO_WORD = new Uint8Array(32);
const LEAF_SIZE = 192;

let zeroHashes: Uint8Array[] | undefined;
// root of an empty subtree at each level (level 0: an empty leaf is 0)
export function lineaZeroHashes(): Uint8Array[] {
	if (!zeroHashes) {
		zeroHashes = [ZERO_WORD];
		for (let i = 0; i < LINEA_DEPTH; i++) zeroHashes.push(poseidon2(concat([zeroHashes[i], zeroHashes[i]])));
	}
	return zeroHashes;
}

export function padIndex(i: number): Uint8Array {
	return poseidon2Pad(numberToBytes(i, { size: 32 }));
}

// inverse of padIndex(): 16 limbs of 4 bytes, each holding 2 bytes
export function unpadIndex(v: Uint8Array): number {
	let x = 0;
	for (let i = 0; i < 16; i++) x = x * 65536 + ((v[4 * i + 2] << 8) | v[4 * i + 3]);
	return x;
}

export function lineaNodePath(level: number, index: number): string {
	return `h${level.toString(16).padStart(2, "0")}${index.toString(16)}`;
}
export function lineaLeafPath(index: number): string {
	return `l${index.toString(16)}`;
}
export function lineaKeyPath(hkey: Uint8Array): string {
	return `${LINEA_KEY_PREFIX}${bytesToHex(hkey).slice(2)}`;
}

// account key: the address left-aligned in a word, padded, without its trailing zero limbs
export function lineaAccountKey(addr: Hex): Uint8Array {
	const word = new Uint8Array(32);
	word.set(hexToBytes(addr));
	const padded = poseidon2Pad(word);
	const lo = new Uint8Array(32);
	lo.set(padded.subarray(32, 40), 24);
	return poseidon2(concat([padded.subarray(0, 32), lo]));
}

// account = nonce . balance . storageRoot . snarkCodeHash . keccakCodeHash . codeSize
export function lineaAccountValueHash(account: Uint8Array): Uint8Array {
	if (account.length !== 192) throw new Error(`expected 192-byte account: ${account.length}`);
	const w = (i: number) => account.subarray(32 * i, 32 * i + 32);
	return poseidon2(
		concat([poseidon2Pad(w(0)), poseidon2Pad(w(1)), w(2), w(3), poseidon2Pad(w(4)), poseidon2Pad(w(5))]),
	);
}

type Leaf = { prev: number; next: number; hkey: Uint8Array; hval: Uint8Array; value: Uint8Array };

function encodeLeaf(leaf: Leaf): Uint8Array {
	return concat([padIndex(leaf.prev), padIndex(leaf.next), leaf.hkey, leaf.hval]);
}

// A sparse Merkle trie that reports the rows it changes.
// set()/delete() apply immediately (the caller decides the order); flush() hashes and returns rows.
export class LineaTrie {
	#nextFreeIndex = 2;
	readonly #leaves = new Map<number, Leaf>();
	readonly #indexOf = new Map<Hex, number>(); // hkey => leaf index
	readonly #sorted: Hex[]; // all hkeys (incl. sentinels), ascending
	readonly #nodes: Map<number, Uint8Array>[] = Array.from({ length: LINEA_DEPTH + 1 }, () => new Map());
	readonly #dirty = new Set<number>(); // leaf indices
	readonly #keys = new Map<Hex, number | null>(); // hkey rows changed since flush()

	constructor() {
		const head = { prev: HEAD_INDEX, next: TAIL_INDEX, hkey: HEAD_HKEY, hval: ZERO_WORD, value: EMPTY_BYTES };
		const tail = { prev: HEAD_INDEX, next: TAIL_INDEX, hkey: TAIL_HKEY, hval: ZERO_WORD, value: EMPTY_BYTES };
		this.#leaves.set(HEAD_INDEX, head);
		this.#leaves.set(TAIL_INDEX, tail);
		this.#sorted = [bytesToHex(HEAD_HKEY), bytesToHex(TAIL_HKEY)];
		for (const [i, hex] of this.#sorted.entries()) {
			this.#indexOf.set(hex, i);
			this.#keys.set(hex, i);
			this.#dirty.add(i);
		}
	}

	get nextFreeIndex() {
		return this.#nextFreeIndex;
	}
	get size() {
		return this.#indexOf.size - 2;
	}

	find(hkey: Uint8Array): { index: number; value: Uint8Array } | undefined {
		const index = this.#indexOf.get(bytesToHex(hkey));
		return index === undefined ? undefined : { index, value: this.#leaves.get(index)!.value };
	}

	set(hkey: Uint8Array, hval: Uint8Array, value: Uint8Array): number {
		const hex = bytesToHex(hkey);
		const index = this.#indexOf.get(hex);
		if (index !== undefined) {
			const leaf = this.#leaves.get(index)!;
			leaf.hval = hval;
			leaf.value = value;
			this.#dirty.add(index);
			return index;
		}
		const pos = this.#lowerBound(hex);
		const left = this.#indexOf.get(this.#sorted[pos - 1])!;
		const right = this.#leaves.get(left)!.next;
		const i = this.#nextFreeIndex++;
		if (i >= 2 ** LINEA_DEPTH) throw new Error("tree is full");
		this.#leaves.get(left)!.next = i;
		this.#leaves.get(right)!.prev = i;
		this.#leaves.set(i, { prev: left, next: right, hkey, hval, value });
		this.#indexOf.set(hex, i);
		this.#sorted.splice(pos, 0, hex);
		this.#keys.set(hex, i);
		this.#dirty.add(left).add(right).add(i);
		return i;
	}

	delete(hkey: Uint8Array): boolean {
		const hex = bytesToHex(hkey);
		const index = this.#indexOf.get(hex);
		if (index === undefined || index <= TAIL_INDEX) return false;
		const { prev, next } = this.#leaves.get(index)!;
		this.#leaves.get(prev)!.next = next;
		this.#leaves.get(next)!.prev = prev;
		this.#leaves.delete(index);
		this.#indexOf.delete(hex);
		this.#sorted.splice(this.#lowerBound(hex), 1);
		this.#keys.set(hex, null);
		this.#dirty.add(prev).add(next).add(index);
		return true;
	}

	#lowerBound(hex: Hex): number {
		let lo = 0;
		let hi = this.#sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.#sorted[mid] < hex) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	#node(level: number, index: number): Uint8Array {
		return this.#nodes[level].get(index) ?? lineaZeroHashes()[level];
	}

	// hash what changed; returns the changed rows
	flush(): TrieRow[] {
		const zero = lineaZeroHashes();
		const rows: TrieRow[] = [];
		const nodeRow = (level: number, index: number, hash: Uint8Array) => {
			const empty = hash.every((x, i) => x === zero[level][i]);
			if (empty) this.#nodes[level].delete(index);
			else this.#nodes[level].set(index, hash);
			if (level < LINEA_DEPTH) rows.push({ path: lineaNodePath(level, index), node: empty ? null : bytesToHex(hash) });
		};
		const dirty = [...this.#dirty].sort((a, b) => a - b);
		this.#dirty.clear();
		let indices = new Set<number>();
		for (const i of dirty) {
			const leaf = this.#leaves.get(i);
			const encoded = leaf && encodeLeaf(leaf);
			rows.push({ path: lineaLeafPath(i), node: encoded ? bytesToHex(concat([encoded, leaf.value])) : null });
			nodeRow(0, i, encoded ? poseidon2(encoded) : ZERO_WORD);
			indices.add(Math.floor(i / 2));
		}
		for (let level = 1; level <= LINEA_DEPTH && dirty.length; level++) {
			const parents = new Set<number>();
			for (const i of indices) {
				nodeRow(level, i, poseidon2(concat([this.#node(level - 1, 2 * i), this.#node(level - 1, 2 * i + 1)])));
				parents.add(Math.floor(i / 2));
			}
			indices = parents;
		}
		for (const [hex, index] of this.#keys) {
			rows.push({ path: lineaKeyPath(hexToBytes(hex)), node: index === null ? null : bytesToHex(numberToBytes(index, { size: 8 })) });
		}
		this.#keys.clear();
		if (dirty.length) rows.push({ path: LINEA_ROOT_PATH, node: bytesToHex(this.#rootNode()) });
		return rows;
	}

	#rootNode(): Uint8Array {
		return concat([padIndex(this.#nextFreeIndex), this.#node(LINEA_DEPTH, 0)]);
	}

	get rootHash(): Hex {
		if (this.#dirty.size) throw new Error("unflushed changes: call flush()");
		return bytesToHex(poseidon2(this.#rootNode()));
	}

	// linea_getProof-style path of an existing key (sibling preimages; after flush())
	pathProof(hkey: Uint8Array): LineaPathProof {
		if (this.#dirty.size) throw new Error("unflushed changes: call flush()");
		const index = this.#indexOf.get(bytesToHex(hkey));
		if (index === undefined) throw new Error("key not found");
		const nodes = [this.#rootNode()];
		for (let level = LINEA_DEPTH - 1; level >= 0; level--) {
			const s = Math.floor(index / 2 ** level);
			const sib = s % 2 ? s - 1 : s + 1;
			if (level) {
				nodes.push(concat([this.#node(level - 1, 2 * sib), this.#node(level - 1, 2 * sib + 1)]));
			} else {
				const leaf = this.#leaves.get(sib);
				nodes.push(leaf ? encodeLeaf(leaf) : ZERO_WORD);
			}
		}
		const leaf = this.#leaves.get(index)!;
		nodes.push(encodeLeaf(leaf));
		return { leafIndex: index, proof: { value: bytesToHex(leaf.value), proofRelatedNodes: nodes.map((x) => bytesToHex(x)) } };
	}

	// every row of the current trie (after flush())
	*rows(): Generator<TrieRow> {
		if (this.#dirty.size) throw new Error("unflushed changes: call flush()");
		yield { path: LINEA_ROOT_PATH, node: bytesToHex(this.#rootNode()) };
		for (const [index, leaf] of this.#leaves) {
			yield { path: lineaLeafPath(index), node: bytesToHex(concat([encodeLeaf(leaf), leaf.value])) };
		}
		for (let level = 0; level < LINEA_DEPTH; level++) {
			for (const [index, hash] of this.#nodes[level]) yield { path: lineaNodePath(level, index), node: bytesToHex(hash) };
		}
		for (const [hex, index] of this.#indexOf) {
			yield { path: lineaKeyPath(hexToBytes(hex)), node: bytesToHex(numberToBytes(index, { size: 8 })) };
		}
	}
}

// Contract storage as a LineaTrie, with Shomei's block semantics:
// writes are buffered and applied by commit(), net changes in ascending hkey order.
export class LineaStorageTrie extends SlotStorage {
	readonly trie = new LineaTrie();
	readonly #pending = new Map<Hex, { slot: Uint8Array; value: Uint8Array }>();

	getStorage(slot: Uint8Array): Uint8Array {
		const pending = this.#pending.get(bytesToHex(toWord(slot)));
		if (pending) return trimLeadingZeros(pending.value);
		return trimLeadingZeros(this.trie.find(lineaHashKey(slot))?.value ?? EMPTY_BYTES);
	}

	setStorage(slot: Uint8Array, value: Uint8Array) {
		slot = toWord(slot).slice();
		this.#pending.set(bytesToHex(slot), { slot, value: toWord(value).slice() });
	}

	get hasPending() {
		return this.#pending.size > 0;
	}

	// end of block: apply the buffered writes, return the changed rows
	commit(): TrieRow[] {
		const writes = Array.from(this.#pending.values(), (x) => {
			const hkey = lineaHashKey(x.slot);
			return { ...x, hkey, hex: bytesToHex(hkey) };
		}).sort((a, b) => (a.hex < b.hex ? -1 : 1));
		this.#pending.clear();
		for (const { value, hkey } of writes) {
			if (trimLeadingZeros(value).length) this.trie.set(hkey, lineaHashValue(value), value);
			else this.trie.delete(hkey);
		}
		return this.trie.flush();
	}

	get storageRoot(): Hex {
		if (this.#pending.size) throw new Error("uncommitted writes: call commit()");
		return this.trie.rootHash;
	}
}

// -- multiproofs (LineaTrie.MultiProof in LineaTrie.sol)

export type LineaMultiProof = {
	top: Hex; // pad(nextFreeIndex) . subRoot
	indices: bigint[]; // ascending
	leaves: Hex[]; // 192 bytes
	values: Hex[]; // raw values ("0x" for leaves that only bound an exclusion)
	siblings: Hex[]; // sibling hashes in consumption order
};

const MULTIPROOF_ABI = [
	{
		type: "tuple",
		components: [
			{ name: "top", type: "bytes" },
			{ name: "indices", type: "uint256[]" },
			{ name: "leaves", type: "bytes[]" },
			{ name: "values", type: "bytes[]" },
			{ name: "siblings", type: "bytes32[]" },
		],
	},
] as const;

export function encodeLineaMultiProof(p: LineaMultiProof): Hex {
	return encodeAbiParameters(MULTIPROOF_ABI, [p]);
}

// the sibling hashes a multiproof over `indices` (sorted, unique) consumes, level by level
// (mirrors LineaTrie.verifyLeaves)
function siblingOrder(indices: number[], sibling: (level: number, index: number) => Uint8Array): Uint8Array[] {
	let idx = indices.slice();
	const out: Uint8Array[] = [];
	for (let level = 0; level < LINEA_DEPTH; level++) {
		const next: number[] = [];
		for (let i = 0; i < idx.length; ) {
			const index = idx[i];
			if (index % 2 === 0 && idx[i + 1] === index + 1) {
				i += 2;
			} else {
				out.push(sibling(level, index % 2 ? index - 1 : index + 1));
				i += 1;
			}
			next.push(Math.floor(index / 2));
		}
		idx = next;
	}
	return out;
}

export type RowGetter = (path: string) => Uint8Array | undefined;
// greatest row with `prefix` and path < `before`
export type RowFloor = (prefix: string, before: string) => { path: string; node: Uint8Array } | undefined;

function leafRow(get: RowGetter, index: number): { leaf: Uint8Array; value: Uint8Array } {
	const row = get(lineaLeafPath(index));
	if (!row || row.length < LEAF_SIZE) throw new Error(`missing leaf #${index}`);
	return { leaf: row.subarray(0, LEAF_SIZE), value: row.subarray(LEAF_SIZE) };
}

// multiproof of `indices` from rows (no hashing)
export function lineaMultiProofFromRows(get: RowGetter, indices: number[]): LineaMultiProof {
	const sorted = [...new Set(indices)].sort((a, b) => a - b);
	const top = get(LINEA_ROOT_PATH);
	if (!top) throw new Error("missing root row");
	const zero = lineaZeroHashes();
	const leaves = sorted.map((i) => leafRow(get, i));
	return {
		top: bytesToHex(top),
		indices: sorted.map(BigInt),
		leaves: leaves.map((x) => bytesToHex(x.leaf)),
		values: leaves.map((x) => bytesToHex(x.value)),
		siblings: siblingOrder(sorted, (level, i) => get(lineaNodePath(level, i)) ?? zero[level]).map((x) => bytesToHex(x)),
	};
}

// storage multiproof of `slots` from rows: each slot's leaf, or the two leaves around it
export function proveLineaSlots(
	get: RowGetter,
	floor: RowFloor,
	slots: Uint8Array[],
): { proof: LineaMultiProof; values: Uint8Array[] } {
	const indices: number[] = [];
	const values = slots.map((slot) => {
		const path = lineaKeyPath(lineaHashKey(slot));
		const found = get(path);
		if (found) {
			const index = Number(BigInt(bytesToHex(found)));
			indices.push(index);
			return leafRow(get, index).value;
		}
		const left = floor(LINEA_KEY_PREFIX, path);
		if (!left) throw new Error("missing HEAD key row");
		const index = Number(BigInt(bytesToHex(left.node)));
		indices.push(index, unpadIndex(leafRow(get, index).leaf.subarray(64, 128)));
		return EMPTY_BYTES;
	});
	return { proof: lineaMultiProofFromRows(get, indices), values };
}

// a linea_getProof path (proofRelatedNodes = [top, sibling preimages top -> bottom, leaf])
export type LineaPathProof = { leafIndex: number; proof: { value: Hex; proofRelatedNodes: Hex[] } };

// one linea_getProof path as a multiproof (hashes the sibling preimages)
export function lineaMultiProofFromPath({ leafIndex, proof }: LineaPathProof): LineaMultiProof {
	const nodes = proof.proofRelatedNodes.map((x) => hexToBytes(x));
	if (nodes.length !== LINEA_DEPTH + 2) throw new Error(`expected ${LINEA_DEPTH + 2} nodes: ${nodes.length}`);
	const siblings = Array.from({ length: LINEA_DEPTH }, (_, level) => {
		const node = nodes[LINEA_DEPTH - level];
		return level === 0 && node.length === 32 ? node : poseidon2(node);
	});
	return {
		top: bytesToHex(nodes[0]),
		indices: [BigInt(leafIndex)],
		leaves: [bytesToHex(nodes[LINEA_DEPTH + 1])],
		values: [proof.value],
		siblings: siblings.map((x) => bytesToHex(x)),
	};
}

// root a multiproof commits to (mirrors LineaTrie.verifyLeaves; for checks and tests)
export function lineaMultiProofRoot(p: LineaMultiProof): Hex {
	let idx = p.indices.map(Number);
	let h = p.leaves.map((x) => poseidon2(hexToBytes(x)));
	let s = 0;
	for (let level = 0; level < LINEA_DEPTH; level++) {
		const ni: number[] = [];
		const nh: Uint8Array[] = [];
		for (let i = 0; i < idx.length; ) {
			const index = idx[i];
			if (index % 2 === 0 && idx[i + 1] === index + 1) {
				nh.push(poseidon2(concat([h[i], h[i + 1]])));
				i += 2;
			} else {
				const sib = hexToBytes(p.siblings[s++]);
				nh.push(poseidon2(index % 2 ? concat([sib, h[i]]) : concat([h[i], sib])));
				i += 1;
			}
			ni.push(Math.floor(index / 2));
		}
		idx = ni;
		h = nh;
	}
	const top = hexToBytes(p.top);
	if (s !== p.siblings.length || bytesToHex(h[0]) !== bytesToHex(top.subarray(64))) throw new Error("invalid multiproof");
	return bytesToHex(poseidon2(top));
}

// storage hash from the root row (what a gateway checks after loading a commit)
export function lineaRootHash(top: Uint8Array | undefined): Hex | undefined {
	return top && bytesToHex(poseidon2(top));
}
