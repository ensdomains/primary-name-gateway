// An L2's commit sources share one indexer database, one at a time: switching keeps the events and
// trie state, and drops the other source's commits and resume state. A lock keeps it to one indexer.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerDB, lockDatabase } from "@primary-name-gateway/registrar-indexer";
import type { Commit } from "@primary-name-gateway/shared";

const commit = (id: number, kind: string) =>
	({ id, kind, status: "valid", l2Block: id, changeSeq: 0, validAt: 0, createdAt: 0 }) as unknown as Commit;

test("switching commit sources drops the other source's commits", () => {
	const db = new IndexerDB(":memory:");
	expect(db.useCommitKind("op")).toBe(0);
	db.insertChanges([{ seq: 1, block: 5, logIndex: 0, kind: "owner", addr: `0x${"11".repeat(20)}`, name: "0x" }]);
	db.setState("syncedBlock", 5);
	db.setState("nextGameIndex", 42);
	db.putCommit(commit(1, "op"));
	db.putCommit(commit(2, "op"));
	expect(db.useCommitKind("op")).toBe(0); // same source: nothing changes
	expect(db.getCommits(undefined, 10)).toHaveLength(2);

	db.putSkipped(7, "bad blob");
	expect(db.useCommitKind("inbox")).toBe(2);
	expect(db.getCommits(undefined, 10)).toEqual([]);
	expect(db.isSkipped(7)).toBeFalse();
	expect(db.getState("nextGameIndex")).toBeUndefined();
	expect(db.getState("syncedBlock")).toBe("5");
	expect(db.lastChangeSeq()).toBe(1);

	db.putCommit(commit(3, "inbox"));
	expect(db.useCommitKind("op")).toBe(1);
	db.close();
});

test("one indexer per database: a second is refused, a stale lock is taken over", () => {
	const dir = mkdtempSync(join(tmpdir(), "indexer-lock-"));
	const path = join(dir, "base.sqlite");
	try {
		const release = lockDatabase(path);
		expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
		expect(() => lockDatabase(path)).toThrow("in use by another indexer");
		release();
		expect(existsSync(`${path}.lock`)).toBeFalse();
		// a lock whose process has exited
		const { pid } = Bun.spawnSync(["true"]);
		writeFileSync(`${path}.lock`, String(pid));
		lockDatabase(path)();
		expect(readdirSync(dir)).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("a database from before commit kinds were recorded keeps its own source's state", () => {
	const db = new IndexerDB(":memory:");
	db.putCommit(commit(1, "op"));
	db.putSkipped(7, "bad game");
	db.setState("nextGameIndex", 42);
	expect(db.useCommitKind("op")).toBe(0); // first run with kinds: nothing to switch from
	expect(db.getCommits(undefined, 10)).toHaveLength(1);
	expect(db.isSkipped(7)).toBeTrue();
	expect(db.getState("nextGameIndex")).toBe("42");
	expect(db.getState("commitKind")).toBe("op");

	const old = new IndexerDB(":memory:");
	old.putCommit(commit(1, "op"));
	old.setState("nextGameIndex", 42);
	expect(old.useCommitKind("inbox")).toBe(1); // it held another kind's commits: a switch
	expect(old.getState("nextGameIndex")).toBeUndefined();
	db.close();
	old.close();
});
