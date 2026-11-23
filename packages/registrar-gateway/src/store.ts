import type { TrieRow } from "@primary-name-gateway/shared";
import { hexToBytes } from "viem";

// Versioned trie rows + a little metadata. A version is the L2 block of a commit.
// get(path, v) = the newest row at `path` with version <= v (a null row means "no node").
//
// Everything is synchronous so it maps onto bun:sqlite and Durable Object SQL alike.
export interface NodeStore {
	get(path: string, version: number): Uint8Array | undefined;
	// the greatest path that starts with `prefix`, is < `before`, and has a node at `version`
	floor(prefix: string, before: string, version: number): { path: string; node: Uint8Array } | undefined;
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
	private sorted: string[] | undefined; // path order cache

	get(path: string, version: number): Uint8Array | undefined {
		const v = this.rows.get(path);
		if (!v) return;
		for (let i = v.length - 1; i >= 0; i--) {
			if (v[i].version <= version) return v[i].node ?? undefined;
		}
		return;
	}
	floor(prefix: string, before: string, version: number) {
		this.sorted ??= [...this.rows.keys()].sort();
		let lo = 0;
		let hi = this.sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.sorted[mid] < before) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo - 1; i >= 0 && this.sorted[i].startsWith(prefix); i--) {
			const node = this.get(this.sorted[i], version);
			if (node) return { path: this.sorted[i], node };
		}
		return;
	}
	put(version: number, rows: TrieRow[]) {
		for (const { path, node } of rows) {
			const entry = { version, node: node === null ? null : hexToBytes(node) };
			const v = this.rows.get(path);
			if (!v) {
				this.rows.set(path, [entry]);
				this.sorted = undefined;
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
			if (!v.length) {
				this.rows.delete(path);
				this.sorted = undefined;
			}
		}
	}
	truncate(maxVersion: number) {
		for (const [path, v] of this.rows) {
			while (v.length && v[v.length - 1].version > maxVersion) v.pop();
			if (!v.length) {
				this.rows.delete(path);
				this.sorted = undefined;
			}
		}
	}
	clear() {
		this.rows.clear();
		this.sorted = undefined;
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

// set once the store has been pruned since it was last cleared: from then on, put() records the
// paths it writes in trie_dirty so prune() only looks at those (see prune)
const META_PRUNED = "trie:pruned";

export class SqlNodeStore implements NodeStore {
	constructor(readonly sql: SqlAdapter) {
		sql.exec(`CREATE TABLE IF NOT EXISTS trie_nodes (
			path TEXT NOT NULL,
			version INTEGER NOT NULL,
			node BLOB,
			PRIMARY KEY (path, version)
		) WITHOUT ROWID`);
		sql.exec(`CREATE TABLE IF NOT EXISTS trie_dirty (
			version INTEGER NOT NULL,
			path TEXT NOT NULL,
			PRIMARY KEY (version, path)
		) WITHOUT ROWID`);
		sql.exec(`CREATE TABLE IF NOT EXISTS gateway_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	}
	get(path: string, version: number): Uint8Array | undefined {
		const [row] = this.sql.exec(
			"SELECT node FROM trie_nodes WHERE path = ? AND version <= ? ORDER BY version DESC LIMIT 1",
			path,
			version,
		);
		return toBytes(row?.node);
	}
	floor(prefix: string, before: string, version: number) {
		// deleted keys are rare: step past them one at a time
		for (;;) {
			const [row] = this.sql.exec(
				"SELECT path FROM trie_nodes WHERE path >= ? AND path < ? AND version <= ? ORDER BY path DESC LIMIT 1",
				prefix,
				before,
				version,
			);
			if (!row) return;
			const path = row.path as string;
			const node = this.get(path, version);
			if (node) return { path, node };
			before = path;
		}
	}
	put(version: number, rows: TrieRow[]) {
		this.sql.transaction(() => {
			const dirty = this.getMeta(META_PRUNED) !== undefined;
			for (const { path, node } of rows) {
				this.sql.exec(
					"INSERT OR REPLACE INTO trie_nodes (path, version, node) VALUES (?, ?, ?)",
					path,
					version,
					node === null ? null : hexToBytes(node),
				);
				if (dirty) this.sql.exec("INSERT OR IGNORE INTO trie_dirty (version, path) VALUES (?, ?)", version, path);
			}
		});
	}
	// A row becomes unreachable once a newer row <= minVersion exists at its path, so after the first
	// prune (a full pass, once per snapshot) only the paths put() recorded since need looking at: the
	// work is proportional to what changed, not to the table. The gateway calls this on every sync.
	prune(minVersion: number) {
		const first = this.getMeta(META_PRUNED) === undefined;
		if (!first && !this.sql.exec("SELECT 1 FROM trie_dirty WHERE version <= ? LIMIT 1", minVersion).length) return;
		const only = first ? "" : "path IN (SELECT path FROM trie_dirty WHERE version <= ?) AND";
		const scope = first ? [] : [minVersion];
		this.sql.transaction(() => {
			// rows older than the newest row <= minVersion at the same path
			this.sql.exec(
				`DELETE FROM trie_nodes WHERE ${only} version < (
					SELECT MAX(t.version) FROM trie_nodes t WHERE t.path = trie_nodes.path AND t.version <= ?
				)`,
				...scope,
				minVersion,
			);
			// what's left <= minVersion is the only row there: drop it if it is a deletion marker
			this.sql.exec(`DELETE FROM trie_nodes WHERE ${only} node IS NULL AND version <= ?`, ...scope, minVersion);
			this.sql.exec("DELETE FROM trie_dirty WHERE version <= ?", minVersion);
			// rows above minVersion written before the first prune weren't recorded (none right after a snapshot)
			if (first) {
				this.sql.exec(
					"INSERT OR IGNORE INTO trie_dirty (version, path) SELECT version, path FROM trie_nodes WHERE version > ?",
					minVersion,
				);
			}
			this.setMeta(META_PRUNED, "1");
		});
	}
	truncate(maxVersion: number) {
		this.sql.transaction(() => {
			this.sql.exec("DELETE FROM trie_nodes WHERE version > ?", maxVersion);
			this.sql.exec("DELETE FROM trie_dirty WHERE version > ?", maxVersion);
		});
	}
	clear() {
		this.sql.transaction(() => {
			this.sql.exec("DELETE FROM trie_nodes");
			this.sql.exec("DELETE FROM trie_dirty");
			this.setMeta(META_PRUNED, undefined);
		});
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

function toBytes(node: unknown): Uint8Array | undefined {
	if (node == null) return;
	return node instanceof Uint8Array ? node : new Uint8Array(node as ArrayBuffer);
}
