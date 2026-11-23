// An L2's commit sources share one indexer database, one at a time: each source's commits stay in it,
// and only the active source's are read. A lock keeps it to one indexer.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerDB, lockDatabase } from "@primary-name-gateway/registrar-indexer";
import type { Commit } from "@primary-name-gateway/shared";

const commit = (id: number, kind: string) =>
	({ id, kind, status: "valid", l2Block: id, changeSeq: 0, validAt: 0, createdAt: 0 }) as unknown as Commit;

test("switching commit sources sets the other's commits aside, and back", () => {
	const db = new IndexerDB(":memory:");
	expect(db.useCommitKind("op")).toBe(0);
	db.insertChanges([{ seq: 1, block: 5, logIndex: 0, kind: "owner", addr: `0x${"11".repeat(20)}`, name: "0x" }]);
	db.setState("syncedBlock", 5);
	db.setState("nextGameIndex", 42);
	db.putCommit(commit(1, "op"));
	db.putCommit({ ...commit(2, "op"), status: "pending" });
	db.putSkipped(7, "bad game");
	expect(db.countCommits()).toEqual({ pending: 1, valid: 1, invalid: 0 });

	expect(db.useCommitKind("inbox")).toBe(2); // set aside, not deleted
	expect(db.getCommits(undefined, 10)).toEqual([]);
	expect(db.getCommit(1)).toBeUndefined();
	expect(db.countCommits()).toEqual({ pending: 0, valid: 0, invalid: 0 });
	db.putCommit(commit(264000000000, "inbox"));
	expect(db.getCommits("valid", 10).map((c) => c.id)).toEqual([264000000000]);
	// shared: the events and the trie's position; each source's own state stays
	expect(db.getState("syncedBlock")).toBe("5");
	expect(db.lastChangeSeq()).toBe(1);
	expect(db.getState("nextGameIndex")).toBe("42");
	expect(db.isSkipped(7)).toBeTrue();

	expect(db.useCommitKind("op")).toBe(1);
	expect(db.getCommits(undefined, 10).map((c) => c.id)).toEqual([2, 1]);
	expect(db.getCommits("valid", 10).map((c) => c.id)).toEqual([1]);
	expect(db.getCommit(264000000000)).toBeUndefined();
	expect(db.getState("commitKind")).toBe("op");
	db.close();
});

test("a commit id can't change kind", () => {
	const db = new IndexerDB(":memory:");
	db.putCommit(commit(1, "op"));
	expect(() => db.putCommit(commit(1, "inbox"))).toThrow("belongs to the op commit source");
	db.putCommit({ ...commit(1, "op"), status: "invalid" }); // same kind: replaced
	expect(db.getCommit(1)?.status).toBe("invalid");
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
