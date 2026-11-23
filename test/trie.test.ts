// trie rows: snapshots, patches and row-walked proofs must match merkle-builder exactly

import { describe, expect, test } from "bun:test";
import { diffRows, proveSlot, rootHash, type TrieRow, trieRows } from "@primary-name-gateway/shared";
import { EthStorage } from "@ensdomains/merkle-builder";
import { bytesToHex, hexToBytes } from "viem";

// deterministic PRNG
function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function slotOf(i: number): Uint8Array {
	const v = new Uint8Array(32);
	new DataView(v.buffer).setUint32(28, i);
	return v;
}

function apply(table: Map<string, Uint8Array>, rows: TrieRow[]) {
	for (const r of rows) {
		if (r.node === null) table.delete(r.path);
		else table.set(r.path, hexToBytes(r.node));
	}
}

function snapshot(storage: EthStorage): Map<string, Uint8Array> {
	const table = new Map<string, Uint8Array>();
	apply(table, [...trieRows(storage.node)]);
	return table;
}

function expectSameTable(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) {
	expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
	for (const [k, v] of a) expect(bytesToHex(v)).toBe(bytesToHex(b.get(k)!));
}

describe("trie rows", () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		test(`patches reproduce the trie and proofs match (seed ${seed})`, () => {
			const random = rng(seed);
			const universe = 400;
			const storage = new EthStorage();
			let table = new Map<string, Uint8Array>();
			for (let round = 0; round < 30; round++) {
				const prev = storage.node;
				const n = 1 + Math.floor(random() * (round === 0 ? 200 : 25));
				for (let k = 0; k < n; k++) {
					const slot = slotOf(Math.floor(random() * universe));
					const r = random();
					// ~30% deletes, rest random words of varying length
					const value = r < 0.3 ? new Uint8Array(0) : Uint8Array.from({ length: 1 + Math.floor(r * 32) }, () => 1 + Math.floor(random() * 255));
					storage.setStorage(slot, value);
				}
				apply(table, diffRows(prev, storage.node));
				expectSameTable(table, snapshot(storage));
				expect(rootHash(table.get(""))).toBe(storage.storageHash);
				for (let i = 0; i < universe; i += 7) {
					const slot = slotOf(i);
					const { proof, value } = proveSlot((p) => table.get(p), slot);
					const expected = storage.getProof(slot);
					if (storage.node) expect(proof).toEqual(expected.proof);
					expect(bytesToHex(value)).toBe(bytesToHex(storage.getStorage(slot)));
				}
				if (round % 10 === 9) table = snapshot(storage); // also exercise fresh snapshots
			}
		});
	}

	test("paged snapshot equals full snapshot", () => {
		const storage = new EthStorage();
		for (let i = 0; i < 500; i++) storage.setStorage(slotOf(i), new Uint8Array([i & 255 || 1, 7]));
		const full = [...trieRows(storage.node)];
		const paged: TrieRow[] = [];
		let after: string | undefined;
		for (;;) {
			const page: TrieRow[] = [];
			for (const r of trieRows(storage.node, after)) {
				page.push(r);
				if (page.length === 37) break;
			}
			if (!page.length) break;
			paged.push(...page);
			after = page[page.length - 1].path;
		}
		expect(paged).toEqual(full);
		expect(full.map((r) => r.path)).toEqual(full.map((r) => r.path).sort());
	});
});
