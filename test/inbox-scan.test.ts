// InboxCommitSource's scan: the newest channel start whose parent L2 block is final is committed,
// passing over newer ones still waiting on L2 finality, and a first start looks further back.
// The L1 scan and the commit itself are stubbed (the verifier side is covered by op-batch-verifier).

import { expect, test } from "bun:test";
import {
	InboxCommitSource,
	IndexerDB,
	NotFinalizedError,
	type RegistrarIndexer,
	SyncError,
} from "@primary-name-gateway/registrar-indexer";
import { BASE_MAINNET_INBOX, type Commit, toLog } from "@primary-name-gateway/shared";
import type { PublicClient } from "viem";

type Batch = { id: number } | "known";

function setup() {
	const db = new IndexerDB(":memory:");
	db.useCommitKind("inbox");
	const logs: string[] = [];
	const indexer = { db, log: toLog((...a: unknown[]) => logs.push(a.join(" "))) } as unknown as RegistrarIndexer;
	const l1 = { getBlock: async () => ({ number: 1_000_000n, timestamp: 10_000_000n }) } as unknown as PublicClient;
	const source = new InboxCommitSource({
		deployment: BASE_MAINNET_INBOX,
		l1,
		l2: {} as never,
		beaconURL: "",
		kzg: async () => ({}) as never,
		intervalSec: 600,
		scanBlocks: 64,
		firstScanBlocks: 300,
		maxL1BlockLag: 7200,
		maxAttempts: 3,
	});
	const depths: number[] = [];
	const tried: number[] = [];
	let batches: Batch[] = [];
	let outcome: (id: number) => Error | undefined = () => undefined;
	Object.assign(source, {
		async *channelStarts(_: RegistrarIndexer, __: bigint, depth: number) {
			depths.push(depth);
			yield* batches;
		},
		async indexCommit(_: RegistrarIndexer, { id }: { id: number }) {
			tried.push(id);
			const err = outcome(id);
			if (err) throw err;
			db.putCommit({
				id,
				kind: "inbox",
				status: "valid",
				l2Block: id,
				l1Block: 999_999,
				createdAt: 0,
			} as unknown as Commit);
		},
	});
	return {
		db,
		logs,
		depths,
		tried,
		tick: (b: Batch[], o: typeof outcome) => {
			batches = b;
			outcome = o;
			tried.length = 0;
			return source.tick(indexer);
		},
	};
}

const notFinal = (id: number) => new NotFinalizedError(`L2 block ${id} is above the finalized head`);

test("the newest batch with a final parent is committed, newer ones waiting on finality are passed over", async () => {
	const s = setup();
	await s.tick([{ id: 3 }, { id: 2 }, { id: 1 }], (id) => (id > 1 ? notFinal(id) : undefined));
	expect(s.tried).toEqual([3, 2, 1]);
	expect(s.db.getCommits("valid", 10).map((c) => c.id)).toEqual([1]);
	expect(s.depths).toEqual([300]); // no commits yet: the first start looks further back
	expect(s.logs.filter((l) => l.includes("trying an earlier batch"))).toHaveLength(2);

	// later: the newest is waiting, and the next one back is already committed
	await s.tick([{ id: 5 }, "known"], notFinal);
	expect(s.tried).toEqual([5]);
	expect(s.db.getCommits("valid", 10).map((c) => c.id)).toEqual([1]);
	expect(s.depths).toEqual([300, 64]);
});

test("none with a final parent: says so, commits nothing", async () => {
	const s = setup();
	await s.tick([{ id: 2 }, { id: 1 }], notFinal);
	expect(s.tried).toEqual([2, 1]);
	expect(s.db.getCommits(undefined, 10)).toEqual([]);
	expect(s.logs.at(-1)).toBe("2 channel starts in the last 300 finalized L1 blocks, none with a final parent yet");
});

test("an event sync failure or a broken batch stops the scan for this tick", async () => {
	const s = setup();
	await s.tick([{ id: 2 }, { id: 1 }], () => new SyncError("getLogs failed"));
	expect(s.tried).toEqual([2]);
	await s.tick([{ id: 2 }, { id: 1 }], () => new Error("bad blob"));
	expect(s.tried).toEqual([2]);
	expect(s.db.getCommits(undefined, 10)).toEqual([]);
});
