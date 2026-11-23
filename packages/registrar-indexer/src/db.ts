import { Database } from "bun:sqlite";
import type { Change, Commit, CommitStatus } from "@primary-name-gateway/shared";
import { type Address, bytesToHex, type Hex, hexToBytes } from "viem";

type ChangeRow = { seq: number; block: number; log_index: number; addr: string; name: Uint8Array };

export class IndexerDB {
	readonly db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS changes (
			seq INTEGER PRIMARY KEY,
			block INTEGER NOT NULL,
			log_index INTEGER NOT NULL,
			addr TEXT NOT NULL,
			name BLOB NOT NULL
		)`);
		this.db.run(`CREATE INDEX IF NOT EXISTS changes_block ON changes (block)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS commits (
			game_index INTEGER PRIMARY KEY,
			status TEXT NOT NULL,
			l2_block INTEGER NOT NULL,
			json TEXT NOT NULL
		)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS skipped (
			game_index INTEGER PRIMARY KEY,
			game TEXT NOT NULL,
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
		const insert = this.db.prepare("INSERT INTO changes (seq, block, log_index, addr, name) VALUES (?, ?, ?, ?, ?)");
		for (const c of changes) insert.run(c.seq, c.block, c.logIndex, c.addr, hexToBytes(c.name));
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
		this.db.run("REPLACE INTO commits (game_index, status, l2_block, json) VALUES (?, ?, ?, ?)", [
			c.gameIndex,
			c.status,
			c.l2Block,
			JSON.stringify(c),
		]);
	}
	getCommit(gameIndex: number): Commit | undefined {
		const row = this.db
			.query<{ json: string }, [number]>("SELECT json FROM commits WHERE game_index = ?")
			.get(gameIndex);
		return row ? JSON.parse(row.json) : undefined;
	}
	// newest first (by L2 block, then game index)
	getCommits(status: CommitStatus | undefined, limit: number): Commit[] {
		const rows = status
			? this.db
					.query<{ json: string }, [string, number]>(
						"SELECT json FROM commits WHERE status = ? ORDER BY l2_block DESC, game_index DESC LIMIT ?",
					)
					.all(status, limit)
			: this.db
					.query<{ json: string }, [number]>(
						"SELECT json FROM commits ORDER BY l2_block DESC, game_index DESC LIMIT ?",
					)
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

	putSkipped(gameIndex: number, game: Address, reason: string) {
		this.db.run("REPLACE INTO skipped (game_index, game, reason) VALUES (?, ?, ?)", [gameIndex, game, reason]);
	}
}

function toChange(row: ChangeRow): Change {
	return {
		seq: row.seq,
		block: row.block,
		logIndex: row.log_index,
		addr: row.addr as Address,
		name: bytesToHex(row.name) as Hex,
	};
}
