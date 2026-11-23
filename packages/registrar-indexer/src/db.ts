import { Database } from "bun:sqlite";
import type { Change, Commit, CommitStatus } from "@primary-name-gateway/shared";
import { type Address, bytesToHex, type Hex, hexToBytes } from "viem";

type ChangeRow = { seq: number; block: number; log_index: number; kind: Change["kind"]; addr: string; name: Uint8Array };

const SCHEMA = "2";

export class IndexerDB {
	readonly db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		const schema = this.getState("schema");
		if (schema !== undefined && schema !== SCHEMA) {
			throw new Error(`${path}: schema ${schema}, expected ${SCHEMA} (delete it to re-index)`);
		}
		if (schema === undefined && this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'commits'").get()) {
			throw new Error(`${path}: created by an older version (delete it to re-index)`);
		}
		this.setState("schema", SCHEMA);
		this.db.run(`CREATE TABLE IF NOT EXISTS changes (
			seq INTEGER PRIMARY KEY,
			block INTEGER NOT NULL,
			log_index INTEGER NOT NULL,
			kind TEXT NOT NULL,
			addr TEXT NOT NULL,
			name BLOB NOT NULL
		)`);
		this.db.run(`CREATE INDEX IF NOT EXISTS changes_block ON changes (block)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS commits (
			id INTEGER PRIMARY KEY,
			status TEXT NOT NULL,
			l2_block INTEGER NOT NULL,
			json TEXT NOT NULL
		)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS skipped (
			id INTEGER PRIMARY KEY,
			reason TEXT NOT NULL
		)`);
	}
	close() {
		this.db.close();
	}

	getState(key: string): string | undefined {
		return this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value;
	}
	setState(key: string, value: string | number) {
		this.db.run("REPLACE INTO state (key, value) VALUES (?, ?)", [key, String(value)]);
	}

	// -- changes

	lastChangeSeq(): number {
		return this.db.query<{ n: number | null }, []>("SELECT MAX(seq) AS n FROM changes").get()?.n ?? 0;
	}
	// last change at or before block
	changeSeqAtBlock(block: number): number {
		return (
			this.db.query<{ n: number | null }, [number]>("SELECT MAX(seq) AS n FROM changes WHERE block <= ?").get(block)
				?.n ?? 0
		);
	}
	insertChanges(changes: Change[]) {
		const insert = this.db.prepare(
			"INSERT INTO changes (seq, block, log_index, kind, addr, name) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const c of changes) insert.run(c.seq, c.block, c.logIndex, c.kind, c.addr, hexToBytes(c.name));
	}
	*iterateChanges(after = 0, until = Number.MAX_SAFE_INTEGER): Generator<Change> {
		for (const row of this.db
			.query<ChangeRow, [number, number]>("SELECT * FROM changes WHERE seq > ? AND seq <= ? ORDER BY seq")
			.iterate(after, until)) {
			yield toChange(row);
		}
	}
	getChanges(after: number, until: number, limit: number): Change[] {
		return this.db
			.query<ChangeRow, [number, number, number]>(
				"SELECT * FROM changes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
			)
			.all(after, until, limit)
			.map(toChange);
	}

	// -- commits

	putCommit(c: Commit) {
		this.db.run("REPLACE INTO commits (id, status, l2_block, json) VALUES (?, ?, ?, ?)", [
			c.id,
			c.status,
			c.l2Block,
			JSON.stringify(c),
		]);
	}
	getCommit(id: number): Commit | undefined {
		const row = this.db.query<{ json: string }, [number]>("SELECT json FROM commits WHERE id = ?").get(id);
		return row ? JSON.parse(row.json) : undefined;
	}
	// newest first (by L2 block, then id)
	getCommits(status: CommitStatus | undefined, limit: number): Commit[] {
		const rows = status
			? this.db
					.query<{ json: string }, [string, number]>(
						"SELECT json FROM commits WHERE status = ? ORDER BY l2_block DESC, id DESC LIMIT ?",
					)
					.all(status, limit)
			: this.db
					.query<{ json: string }, [number]>("SELECT json FROM commits ORDER BY l2_block DESC, id DESC LIMIT ?")
					.all(limit);
		return rows.map((x) => JSON.parse(x.json));
	}
	countCommits(): Record<CommitStatus, number> {
		const counts = { pending: 0, valid: 0, invalid: 0 };
		for (const { status, n } of this.db
			.query<{ status: CommitStatus; n: number }, []>("SELECT status, COUNT(*) AS n FROM commits GROUP BY status")
			.all()) {
			counts[status] = n;
		}
		return counts;
	}

	putSkipped(id: number, reason: string) {
		this.db.run("REPLACE INTO skipped (id, reason) VALUES (?, ?)", [id, reason]);
	}
	isSkipped(id: number): boolean {
		return !!this.db.query("SELECT 1 FROM skipped WHERE id = ?").get(id);
	}
}

function toChange(row: ChangeRow): Change {
	return {
		seq: row.seq,
		block: row.block,
		logIndex: row.log_index,
		kind: row.kind,
		addr: row.addr as Address,
		name: bytesToHex(row.name) as Hex,
	};
}
