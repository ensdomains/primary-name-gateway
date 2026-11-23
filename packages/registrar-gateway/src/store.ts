import type { TrieRow } from "@primary-name-gateway/shared";
import { hexToBytes } from "viem";

// Versioned trie rows + a little metadata. A version is the L2 block of a commit.
// get(path, v) = the newest row at `path` with version <= v (a null row means "no node").
//
// Everything is synchronous so it maps onto bun:sqlite and Durable Object SQL alike.
export interface NodeStore {
	get(path: string, version: number): Uint8Array | undefined;
	put(version: number, rows: TrieRow[]): void; // atomic
	prune(minVersion: number): void; // forget what's only needed for versions < minVersion
	truncate(maxVersion: number): void; // drop rows newer than maxVersion
	clear(): void; // drop all rows (metadata is kept)
	getMeta(key: string): string | undefined;
	setMeta(key: string, value: string | undefined): void;
}

export class MemoryNodeStore implements NodeStore {
	// path => rows ascending by version
	private readonly rows = new Map<string, { version: number; node: Uint8Array | null }[]>();
	private readonly meta = new Map<string, string>();

	get(path: string, version: number): Uint8Array | undefined {
		const v = this.rows.get(path);
		if (!v) return;
		for (let i = v.length - 1; i >= 0; i--) {
			if (v[i].version <= version) return v[i].node ?? undefined;
		}
		return;
	}
	put(version: number, rows: TrieRow[]) {
		for (const { path, node } of rows) {
			const entry = { version, node: node === null ? null : hexToBytes(node) };
			const v = this.rows.get(path);
			if (!v) {
				this.rows.set(path, [entry]);
			} else if (v[v.length - 1].version === version) {
				v[v.length - 1] = entry;
			} else {
				if (v[v.length - 1].version > version) throw new Error(`version ${version} is older than stored`);
				v.push(entry);
			}
		}
	}
	prune(minVersion: number) {
		for (const [path, v] of this.rows) {
			// index of the newest row <= minVersion: everything before it is unreachable
			let i = v.length - 1;
			while (i > 0 && v[i].version > minVersion) i--;
			if (i > 0) v.splice(0, i);
			// a deletion marker that is now the oldest row reads the same as no row
			if (v[0].node === null && v[0].version <= minVersion) v.shift();
			if (!v.length) this.rows.delete(path);
		}
	}
	truncate(maxVersion: number) {
		for (const [path, v] of this.rows) {
			while (v.length && v[v.length - 1].version > maxVersion) v.pop();
			if (!v.length) this.rows.delete(path);
		}
	}
	clear() {
		this.rows.clear();
	}
	getMeta(key: string) {
		return this.meta.get(key);
	}
	setMeta(key: string, value: string | undefined) {
		if (value === undefined) this.meta.delete(key);
		else this.meta.set(key, value);
	}
}

// Minimal SQL surface shared by bun:sqlite and Durable Object storage:
//   bun:  { exec: (q, ...p) => db.query(q).all(...p), transaction: (fn) => db.transaction(fn)() }
//   DO:   { exec: (q, ...p) => ctx.storage.sql.exec(q, ...p).toArray(), transaction: (fn) => ctx.storage.transactionSync(fn) }
export type SqlAdapter = {
	exec(query: string, ...params: (string | number | Uint8Array | null)[]): Record<string, unknown>[];
	transaction<T>(fn: () => T): T;
};

export class SqlNodeStore implements NodeStore {
	constructor(readonly sql: SqlAdapter) {
		sql.exec(`CREATE TABLE IF NOT EXISTS trie_nodes (
			path TEXT NOT NULL,
			version INTEGER NOT NULL,
			node BLOB,
			PRIMARY KEY (path, version)
		) WITHOUT ROWID`);
		sql.exec(`CREATE TABLE IF NOT EXISTS gateway_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	}
	get(path: string, version: number): Uint8Array | undefined {
		const [row] = this.sql.exec(
			"SELECT node FROM trie_nodes WHERE path = ? AND version <= ? ORDER BY version DESC LIMIT 1",
			path,
			version,
		);
		const node = row?.node;
		if (node == null) return;
		return node instanceof Uint8Array ? node : new Uint8Array(node as ArrayBuffer);
	}
	put(version: number, rows: TrieRow[]) {
		this.sql.transaction(() => {
			for (const { path, node } of rows) {
				this.sql.exec(
					"INSERT OR REPLACE INTO trie_nodes (path, version, node) VALUES (?, ?, ?)",
					path,
					version,
					node === null ? null : hexToBytes(node),
				);
			}
		});
	}
	prune(minVersion: number) {
		this.sql.transaction(() => {
			// rows older than the newest row <= minVersion at the same path
			this.sql.exec(
				`DELETE FROM trie_nodes WHERE version < (
					SELECT MAX(t.version) FROM trie_nodes t WHERE t.path = trie_nodes.path AND t.version <= ?
				)`,
				minVersion,
			);
			// what's left <= minVersion is the only row there: drop it if it is a deletion marker
			this.sql.exec("DELETE FROM trie_nodes WHERE node IS NULL AND version <= ?", minVersion);
		});
	}
	truncate(maxVersion: number) {
		this.sql.exec("DELETE FROM trie_nodes WHERE version > ?", maxVersion);
	}
	clear() {
		this.sql.exec("DELETE FROM trie_nodes");
	}
	getMeta(key: string): string | undefined {
		const [row] = this.sql.exec("SELECT value FROM gateway_meta WHERE key = ?", key);
		return row?.value as string | undefined;
	}
	setMeta(key: string, value: string | undefined) {
		if (value === undefined) this.sql.exec("DELETE FROM gateway_meta WHERE key = ?", key);
		else this.sql.exec("INSERT OR REPLACE INTO gateway_meta (key, value) VALUES (?, ?)", key, value);
	}
}
