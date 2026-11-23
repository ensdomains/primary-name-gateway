import type { Database, Statement } from "bun:sqlite";
import type { TrieRow } from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes } from "viem";

// Versions that must stay readable. An entry written at version u and replaced at v is read by
// the kept versions in [u, v); without any, it can be overwritten.
export class KeptVersions {
	private kept: number[] = []; // ascending

	set(versions: Iterable<number>) {
		this.kept = [...new Set(versions)].sort((a, b) => a - b);
	}
	has(v: number): boolean {
		return this.kept.includes(v);
	}
	get values(): readonly number[] {
		return this.kept;
	}
	// smallest kept version > v
	firstAfter(v: number): number | undefined {
		let lo = 0;
		let hi = this.kept.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.kept[mid] <= v) lo = mid + 1;
			else hi = mid;
		}
		return this.kept[lo];
	}
	needed(u: number, v: number): boolean {
		let lo = 0;
		let hi = this.kept.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.kept[mid] < u) lo = mid + 1;
			else hi = mid;
		}
		return lo < this.kept.length && this.kept[lo] < v;
	}
}

type HeadRow = { v: number; node: Uint8Array | null };

// Versioned trie rows in SQLite, keeping only what the kept versions (and the newest state) read.
//
// trie_head:    the newest entry of every path; node NULL (a tombstone) only while history needs it
// trie_history: older entries still read by a kept version (every such path has a head row)
export class SqlRowLog {
	readonly kept = new KeptVersions();
	private readonly q: Record<string, Statement>;

	constructor(readonly db: Database) {
		db.run(`CREATE TABLE IF NOT EXISTS trie_head (
			path TEXT PRIMARY KEY,
			v INTEGER NOT NULL,
			node BLOB
		) WITHOUT ROWID`);
		db.run(`CREATE INDEX IF NOT EXISTS trie_head_v ON trie_head (v)`);
		db.run(`CREATE TABLE IF NOT EXISTS trie_history (
			path TEXT NOT NULL,
			v INTEGER NOT NULL,
			node BLOB,
			PRIMARY KEY (path, v)
		) WITHOUT ROWID`);
		db.run(`CREATE INDEX IF NOT EXISTS trie_history_v ON trie_history (v)`);
		// node of h.path at version :v
		const at = `CASE WHEN h.v <= :v THEN h.node ELSE (
			SELECT x.node FROM trie_history x WHERE x.path = h.path AND x.v <= :v ORDER BY x.v DESC LIMIT 1
		) END`;
		this.q = {
			head: db.prepare("SELECT v, node FROM trie_head WHERE path = ?"),
			setHead: db.prepare("REPLACE INTO trie_head (path, v, node) VALUES (?, ?, ?)"),
			deleteHead: db.prepare("DELETE FROM trie_head WHERE path = ?"),
			addHistory: db.prepare("INSERT INTO trie_history (path, v, node) VALUES (?, ?, ?)"),
			hasHistory: db.prepare("SELECT 1 FROM trie_history WHERE path = ? LIMIT 1"),
			get: db.prepare(`SELECT ${at} AS node FROM trie_head h WHERE h.path = :path`),
			rowsAt: db.prepare(`SELECT path, node FROM (
				SELECT h.path AS path, ${at} AS node FROM trie_head h WHERE h.path >= :from ORDER BY h.path
			) WHERE node IS NOT NULL AND (:after IS NULL OR path != :after) LIMIT :limit`),
			range: db.prepare(`SELECT path, node FROM (
				SELECT h.path AS path, ${at} AS node FROM trie_head h
				WHERE h.path >= :from AND (:to IS NULL OR h.path < :to) ORDER BY h.path
			) WHERE node IS NOT NULL LIMIT :limit`),
			changed: db.prepare(`SELECT h.path AS path, ${at} AS node FROM trie_head h WHERE h.path IN (
				SELECT path FROM trie_head WHERE v > :from AND v <= :v
				UNION SELECT path FROM trie_history WHERE v > :from AND v <= :v
			)`),
			history: db.prepare(`SELECT x.path AS path, x.v AS v, x.node IS NULL AS removed, h.v AS hv, h.node IS NULL AS tomb
				FROM trie_history x JOIN trie_head h USING (path) ORDER BY x.path, x.v`),
			deleteHistory: db.prepare("DELETE FROM trie_history WHERE path = ? AND v = ?"),
			setHistory: db.prepare("REPLACE INTO trie_history (path, v, node) VALUES (?, ?, ?)"),
			nextVersion: db.prepare(`SELECT MIN(v) AS v FROM (
				SELECT v FROM trie_history WHERE path = :path AND v > :v UNION ALL SELECT v FROM trie_head WHERE path = :path AND v > :v
			)`),
			writtenAfter: db.prepare(
				"SELECT path FROM trie_head WHERE v > :v UNION SELECT path FROM trie_history WHERE v > :v",
			),
		};
	}

	// newest node at path (what EthRowStorage reads)
	head(path: string): Uint8Array | undefined {
		return (this.q.head.get(path) as HeadRow | null)?.node ?? undefined;
	}

	// node at path in version v (v must be kept or the newest)
	get(path: string, v: number): Uint8Array | undefined {
		return (this.q.get.get({ path, v }) as { node: Uint8Array | null } | null)?.node ?? undefined;
	}

	// call inside a transaction
	put(v: number, rows: TrieRow[]) {
		const { q, kept } = this;
		for (const { path, node } of rows) {
			const cur = q.head.get(path) as HeadRow | null;
			if (cur && cur.v > v) throw new Error(`version ${v} is older than ${cur.v}`);
			let moved = false;
			if (cur && cur.v !== v && kept.needed(cur.v, v)) {
				q.addHistory.run(path, cur.v, cur.node);
				moved = true;
			}
			if (node !== null) {
				q.setHead.run(path, v, hexToBytes(node));
			} else if (cur) {
				if (moved || q.hasHistory.get(path)) q.setHead.run(path, v, null);
				else q.deleteHead.run(path);
			}
		}
	}

	// Make an older version v readable again (an out-of-order commit), given the rows that turn the
	// newest version into v. Merged entries make v read wrong only at paths written after v; each
	// gets an entry at v, plus one at the next kept version so that it still reads what it did.
	// Call inside a transaction, before writing anything newer, then keep v.
	restore(v: number, rows: TrieRow[]) {
		const { q, kept } = this;
		const want = new Map<string, Hex | null>(rows.map((r) => [r.path, r.node]));
		const paths = new Set(want.keys());
		for (const { path } of q.writtenAfter.all({ v }) as { path: string }[]) paths.add(path);
		const bytes = (x: Hex | null) => x && hexToBytes(x);
		for (const path of paths) {
			const head = q.head.get(path) as HeadRow | null;
			const node = want.has(path) ? want.get(path)! : head?.node ? bytesToHex(head.node) : null;
			const read = this.get(path, v);
			const cur = read ? bytesToHex(read) : null;
			if (cur === node) continue;
			if (!head || head.v <= v) {
				// absent now (removed without history, or a tombstone an earlier restore put below v)
				if (head?.node) throw new Error(`restore ${v}: ${path} has no newer entry`);
				if (head) q.setHistory.run(path, head.v, null);
				q.setHead.run(path, v + 1, null);
			} else {
				const next = (q.nextVersion.get({ path, v }) as { v: number }).v;
				const k = kept.firstAfter(v);
				if (k !== undefined && k < next) q.setHistory.run(path, k, bytes(cur));
			}
			q.setHistory.run(path, v, bytes(node));
		}
	}

	// set the kept versions, dropping history no longer read (call inside a transaction)
	keep(versions: Iterable<number>) {
		const before = this.kept.values;
		this.kept.set(versions);
		if (before.some((v) => !this.kept.has(v))) this.prune();
	}

	private prune() {
		type H = { path: string; v: number; removed: number; hv: number; tomb: number };
		const { q, kept } = this;
		let group: H[] = [];
		const flush = () => {
			if (!group.length) return;
			const { path, hv, tomb } = group[0];
			let live = group.filter((e, i) => kept.needed(e.v, group[i + 1]?.v ?? hv));
			// a leading removal reads the same as no entry
			while (live.length && live[0].removed) live = live.slice(1);
			for (const e of group) if (!live.includes(e)) q.deleteHistory.run(path, e.v);
			if (!live.length && tomb) q.deleteHead.run(path);
			group = [];
		};
		for (const e of q.history.all() as H[]) {
			if (group.length && group[0].path !== e.path) flush();
			group.push(e);
		}
		flush();
	}

	// rows of version v in path order, after `after`
	rowsAt(v: number, after: string | undefined, limit: number): TrieRow[] {
		const from = after ?? "";
		return (this.q.rowsAt.all({ v, from, after: after ?? null, limit }) as { path: string; node: Uint8Array }[]).map(
			({ path, node }) => ({ path, node: bytesToHex(node) }),
		);
	}

	// live rows of version v with from <= path < to, in path order
	range(v: number, from: string, to: string | undefined, limit: number): TrieRow[] {
		return (this.q.range.all({ v, from, to: to ?? null, limit }) as { path: string; node: Uint8Array }[]).map(
			({ path, node }) => ({ path, node: bytesToHex(node) }),
		);
	}

	// rows that turn version `from` into version v
	changed(from: number, v: number): TrieRow[] {
		return (this.q.changed.all({ from, v }) as { path: string; node: Uint8Array | null }[]).map(({ path, node }) => ({
			path,
			node: node && (bytesToHex(node) as Hex),
		}));
	}
}
