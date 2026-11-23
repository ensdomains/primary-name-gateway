// The indexer's SQL row log (EthRowStorage over SqlRowLog) must reproduce merkle-builder's EthStorage
// at every kept version: snapshots, patches between kept versions, and row-walked proofs.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EthRowStorage, EthStorage, type MaybeNode, trieRows } from "@ensdomains/merkle-builder";
import { SqlRowLog } from "@primary-name-gateway/registrar-indexer";
import { proveSlot, rootHash, type TrieRow } from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes } from "viem";

// deterministic PRNG
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

function apply(table: Map<string, Hex>, rows: TrieRow[]) {
	for (const r of rows) {
		if (r.node === null) table.delete(r.path);
		else table.set(r.path, r.node);
	}
}

function tableOf(node: MaybeNode): Map<string, Hex> {
	return new Map([...trieRows(node)].map((r) => [r.path, r.node]));
}

function pagedRows(log: SqlRowLog, v: number, limit: number): TrieRow[] {
	const out: TrieRow[] = [];
	let after: string | undefined;
	for (;;) {
		const rows = log.rowsAt(v, after, limit);
		out.push(...rows);
		if (rows.length < limit) return out;
		after = rows[rows.length - 1].path;
	}
}

describe("SqlRowLog", () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		test(`kept versions match EthStorage (seed ${seed})`, () => {
			const random = rng(seed);
			const universe = 400;
			const db = new Database(":memory:");
			const log = new SqlRowLog(db);
			const rows = new EthRowStorage((p) => log.head(p));
			const eth = new EthStorage();
			const kept = new Map<number, MaybeNode>(); // version => trie
			const all: MaybeNode[] = [undefined]; // every version's trie
			for (let v = 1; v <= 40; v++) {
				const n = 1 + Math.floor(random() * (v === 1 ? 200 : 25));
				for (let k = 0; k < n; k++) {
					const slot = slotOf(Math.floor(random() * universe));
					const r = random();
					// ~30% deletes, rest random words of varying length
					const value =
						r < 0.3
							? new Uint8Array(0)
							: Uint8Array.from({ length: 1 + Math.floor(r * 32) }, () => 1 + Math.floor(random() * 255));
					eth.setStorage(slot, value);
					rows.setStorage(slot, value);
				}
				const { rows: changed, storageHash } = rows.commit();
				expect(storageHash).toBe(eth.storageHash);
				db.transaction(() => log.put(v, changed))();
				all.push(eth.node);
				if (random() < 0.3) kept.set(v, eth.node);
				if (random() < 0.2 && kept.size) kept.delete([...kept.keys()][Math.floor(random() * kept.size)]);
				db.transaction(() => log.keep(kept.keys()))();
				// bring back an older version that wasn't kept (an out-of-order commit)
				const old = 1 + Math.floor(random() * (v - 1));
				if (random() < 0.25 && v > 1 && !kept.has(old)) {
					const head = tableOf(eth.node);
					const want = tableOf(all[old]);
					const rows: TrieRow[] = [...want]
						.filter(([p, n]) => head.get(p) !== n)
						.map(([path, node]) => ({ path, node }));
					for (const path of head.keys()) if (!want.has(path)) rows.push({ path, node: null });
					kept.set(old, all[old]);
					db.transaction(() => {
						log.restore(old, rows);
						log.keep(kept.keys());
					})();
				}

				// the newest version always reads as the current trie
				expect(pagedRows(log, v, 1000)).toEqual([...trieRows(eth.node)]);
				const versions = [...kept.keys()].sort((a, b) => a - b);
				for (const [i, a] of versions.entries()) {
					const node = kept.get(a);
					const full = [...trieRows(node)];
					expect(pagedRows(log, a, 37)).toEqual(full);
					expect(rootHash(log.get("", a))).toBe(new EthStorage(node).storageHash);
					// a patch from every older kept version
					for (const b of versions.slice(i + 1)) {
						const table = tableOf(node);
						apply(table, log.changed(a, b));
						expect(table).toEqual(tableOf(kept.get(b)));
					}
					const storage = new EthStorage(node);
					for (let s = 0; s < universe; s += 13) {
						const slot = slotOf(s);
						const { proof, value } = proveSlot((p) => log.get(p, a), slot);
						if (node) expect(proof).toEqual(storage.getProof(slot).proof);
						expect(bytesToHex(value)).toBe(bytesToHex(storage.getStorage(slot)));
					}
				}
			}
			db.close();
		});
	}

	test("a removed path keeps a tombstone only while a kept version reads it", () => {
		const db = new Database(":memory:");
		const log = new SqlRowLog(db);
		const node = (x: number) => bytesToHex(Uint8Array.of(0xc1, x));
		log.put(1, [{ path: "a", node: node(1) }]);
		log.keep([1]);
		log.put(2, [{ path: "a", node: null }]);
		expect(log.get("a", 1)).toEqual(hexToBytes(node(1)));
		expect(log.get("a", 2)).toBeUndefined();
		expect(log.head("a")).toBeUndefined();
		log.keep([]);
		expect(db.query("SELECT COUNT(*) AS n FROM trie_head").get()).toEqual({ n: 0 });
		expect(db.query("SELECT COUNT(*) AS n FROM trie_history").get()).toEqual({ n: 0 });
		db.close();
	});
});
