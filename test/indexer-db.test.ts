// An L2's commit sources share one indexer database, one at a time: switching keeps the events and
// trie state, and drops the other source's commits and resume state.

import { expect, test } from "bun:test";
import { IndexerDB } from "@primary-name-gateway/registrar-indexer";
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
