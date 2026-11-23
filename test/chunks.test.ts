// Chunk rows (shared/trie.ts, registrar-indexer/src/chunks.ts) against merkle-builder's EthStorage
// on a trie deep enough for limbs: paged snapshots, patches between versions, and proofs.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EthRowStorage, EthStorage, type MaybeNode, trieRows } from "@ensdomains/merkle-builder";
import { chunkPage, chunkPatch, type NodeSource, SqlRowLog } from "@primary-name-gateway/registrar-indexer";
import {
	CHUNK_DEPTH,
	chunkId,
	chunkReader,
	decodeLimb,
	encodeLimb,
	proveSlot,
	type TrieRow,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes } from "viem";

function rng(seed: number) {
	return () => {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function slotOf(i: number): Uint8Array {
	const v = new Uint8Array(32);
	new DataView(v.buffer).setUint32(28, i);
	return v;
}

// the chunk table of a trie, built directly from its nodes
function chunksOf(node: MaybeNode): Map<string, Hex> {
	const groups = new Map<string, { suffix: string; node: Uint8Array }[]>();
	const table = new Map<string, Hex>();
	for (const r of trieRows(node)) {
		if (r.path.length < CHUNK_DEPTH) table.set(r.path, r.node);
		else {
			const id = chunkId(r.path);
			if (!groups.has(id)) groups.set(id, []);
			groups.get(id)!.push({ suffix: r.path.slice(CHUNK_DEPTH), node: hexToBytes(r.node) });
		}
	}
	for (const [id, nodes] of groups) table.set(id, bytesToHex(encodeLimb(nodes)));
	return table;
}

function apply(table: Map<string, Hex>, rows: TrieRow[]) {
	for (const r of rows) {
		if (r.node === null) table.delete(r.path);
		else table.set(r.path, r.node);
	}
}

test("limb encoding round-trips", () => {
	const random = rng(3);
	const hex = "0123456789abcdef";
	for (let t = 0; t < 200; t++) {
		const nodes = Array.from({ length: Math.floor(random() * 20) }, () => ({
			suffix: Array.from({ length: Math.floor(random() * 61) }, () => hex[Math.floor(random() * 16)]).join(""),
			node: Uint8Array.from({ length: 1 + Math.floor(random() * 532) }, () => Math.floor(random() * 256)),
		}));
		expect(decodeLimb(encodeLimb(nodes))).toEqual(nodes);
	}
});

describe("chunks match EthStorage", () => {
	for (const seed of [1, 2]) {
		test(`seed ${seed}: paged snapshots, patches and proofs`, () => {
			const random = rng(seed);
			const universe = 60_000; // deep enough for limbs (depth 4+)
			const db = new Database(":memory:");
			const log = new SqlRowLog(db);
			const rows = new EthRowStorage((p) => log.head(p));
			const eth = new EthStorage();
			const kept = new Map<number, MaybeNode>();
			const source = (v: number): NodeSource => ({
				range: (from, to, limit) => log.range(v, from, to, limit),
				get: (path) => log.get(path, v),
			});
			let limbs = 0;
			for (let v = 1; v <= 4; v++) {
				const n = v === 1 ? 20_000 : 400;
				for (let k = 0; k < n; k++) {
					const slot = slotOf(Math.floor(random() * universe));
					const value =
						random() < 0.2
							? new Uint8Array(0)
							: Uint8Array.from({ length: 1 + Math.floor(random() * 32) }, () => 1 + Math.floor(random() * 255));
					eth.setStorage(slot, value);
					rows.setStorage(slot, value);
				}
				const { rows: changed } = rows.commit();
				db.transaction(() => log.put(v, changed))();
				kept.set(v, eth.node);
				db.transaction(() => log.keep(kept.keys()))();

				const want = chunksOf(eth.node);
				limbs = [...want.keys()].filter((id) => id.length === CHUNK_DEPTH).length;
				// paged snapshot (small budgets cut pages at trunk and limb boundaries)
				for (const budget of [777, 1_000_000]) {
					const got = new Map<string, Hex>();
					let after: string | undefined;
					for (;;) {
						const page = chunkPage(source(v), after, budget);
						for (const r of page.rows) {
							expect(got.has(r.path)).toBeFalse();
							got.set(r.path, r.node!);
						}
						if (page.next === null) break;
						after = page.next;
					}
					expect(got).toEqual(want);
				}
				// patches from every older version
				for (const [a, node] of kept) {
					if (a === v) continue;
					const table = chunksOf(node);
					apply(
						table,
						chunkPatch(
							log.changed(a, v).map((r) => r.path),
							source(v),
						),
					);
					expect(table).toEqual(want);
				}
				// proofs through the chunk reader: present and absent slots
				for (let s = 0; s < universe; s += 997) {
					const slot = slotOf(s);
					const ids: string[] = [];
					const read = chunkReader((id) => {
						ids.push(id);
						const x = want.get(id);
						return x ? hexToBytes(x) : undefined;
					});
					const { proof, value } = proveSlot(read, slot);
					expect(proof).toEqual(eth.getProof(slot).proof);
					expect(bytesToHex(value)).toBe(bytesToHex(eth.getStorage(slot)));
					expect(new Set(ids).size).toBe(ids.length); // each chunk read once
					expect(ids.length).toBeLessThanOrEqual(CHUNK_DEPTH + 1);
				}
			}
			expect(limbs).toBeGreaterThan(1000);
			db.close();
		}, 120_000);
	}
});
