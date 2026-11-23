// MemoryNodeStore and SqlNodeStore must agree on versioned reads (get, floor) through put/prune/truncate,
// and SqlNodeStore's incremental prune must leave nothing a full prune would drop

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { TrieRow } from "@primary-name-gateway/shared";
import { bytesToHex, type Hex } from "viem";
import { MemoryNodeStore, type NodeStore, SqlNodeStore } from "../packages/registrar-gateway/src/index.js";
import { bunSqliteAdapter } from "../packages/registrar-gateway/src/sqlite.js";

test("memory and sql stores match an unpruned reference", () => {
	let seed = 7;
	const random = () => {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const db = new Database(":memory:");
	const stores: NodeStore[] = [new MemoryNodeStore(), new SqlNodeStore(bunSqliteAdapter(db))];
	const paths = Array.from({ length: 40 }, (_, i) => i.toString(16));
	// reference: full history, never pruned (prune must not change reads at versions >= minVersion)
	let history: { version: number; rows: TrieRow[] }[] = [];
	const expected = (v: number) =>
		paths.map((p) => {
			let node: Hex | null | undefined;
			for (const h of history) if (h.version <= v) for (const r of h.rows) if (r.path === p) node = r.node;
			return node ?? undefined;
		});
	let version = 0;
	let minVersion = 0;
	let prunes = 0;
	const read = (s: NodeStore, v: number) =>
		paths.map((p) => {
			const x = s.get(p, v);
			return x && bytesToHex(x);
		});
	for (let step = 0; step < 300; step++) {
		const r = random();
		if (r < 0.7) {
			// sometimes write again at the current version (after a truncate, that can be the pruned one)
			if (random() < 0.8) version += 1 + Math.floor(random() * 3);
			const rows: TrieRow[] = paths
				.filter(() => random() < 0.2)
				.map((path) => ({
					path,
					node: random() < 0.25 ? null : (`0x${(step + 1).toString(16).padStart(4, "0")}` as Hex),
				}));
			for (const s of stores) s.put(version, rows);
			history.push({ version, rows });
		} else if (r < 0.85) {
			minVersion = Math.max(minVersion, version - Math.floor(random() * 6));
			for (const s of stores) s.prune(minVersion);
			// SqlNodeStore prunes incrementally: nothing a full prune would drop may be left. At or below
			// minVersion only each path's newest row is kept, and only if it's a node.
			const left = db
				.query(
					`SELECT COUNT(*) AS n FROM trie_nodes WHERE version <= ? AND (node IS NULL OR version < (
						SELECT MAX(t.version) FROM trie_nodes t WHERE t.path = trie_nodes.path AND t.version <= ?
					))`,
				)
				.get(minVersion, minVersion) as { n: number };
			expect(left.n).toBe(0);
			prunes++;
		} else {
			version = Math.max(minVersion, version - Math.floor(random() * 4));
			for (const s of stores) s.truncate(version);
			history = history.filter((h) => h.version <= version);
		}
		for (let v = minVersion; v <= version + 1; v++) {
			const want = expected(v);
			expect(read(stores[0], v)).toEqual(want);
			expect(read(stores[1], v)).toEqual(want);
			// floor: the greatest live path below `before`
			const before = random() < 0.1 ? "z" : paths[Math.floor(random() * paths.length)];
			const live = paths.filter((p, i) => p < before && want[i] !== undefined).sort();
			const floor = live.length
				? { path: live[live.length - 1], node: want[paths.indexOf(live[live.length - 1])] as Hex }
				: undefined;
			for (const s of stores) {
				const f = s.floor("", before, v);
				expect(f && { path: f.path, node: bytesToHex(f.node) }).toEqual(floor);
			}
		}
	}
	expect(prunes).toBeGreaterThan(20);
	db.close();
});
