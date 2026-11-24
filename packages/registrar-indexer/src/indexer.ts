import {
	type Change,
	type Commit,
	type CommitKind,
	type Deployment,
	type IndexerStatus,
	type Log,
	type TrieRow,
	toLog,
} from "@primary-name-gateway/shared";
import type { Hex } from "viem";
import type { IndexerDB } from "./db.js";
import type { ChangeReader } from "./l2.js";
import { duration, n, Progress } from "./progress.js";
import { createIndexerTrie, type IndexerTrie, type RowPage } from "./tries.js";

// Finds commits on L1 and captures what the verifier will need from the L2 at that moment.
// OPCommitSource: dispute games, LineaCommitSource: finalizations.
export interface CommitSource {
	tick(indexer: RegistrarIndexer): Promise<void>;
	status?(): Partial<IndexerStatus>; // settings a verifier must match (OP: minAgeSec)
}

// the commit's L2 block isn't final yet: try again later (not a failure)
export class NotFinalizedError extends Error {}

// fetching the L2's events failed: try again later (not the commit's fault, so not a failed attempt)
export class SyncError extends Error {}

export type IndexerConfig = {
	chain?: string; // the deployment's name, reported by /status (gateways take their deployment from it)
	deployment: Deployment;
	l2: ChangeReader;
	source: CommitSource;
	db: IndexerDB;
	retainValid?: number; // keep tries of this many recent valid commits for /patch (default 24)
	catchUpBlocks?: number; // catch up to this many blocks below the L2's finalized head (default 10,000)
	log?: Log | ((...args: unknown[]) => void);
};

// Replays the L2 registrar's events into its storage trie and keeps the tries of recent commits.
//
// Invariant: `trie` is the registrar trie after all changes in blocks <= `syncedBlock`.
export class RegistrarIndexer {
	readonly trie: IndexerTrie;
	syncedBlock: number;
	changeSeq = 0;
	syncingTo?: number; // the L2 block a sync in progress is headed for

	constructor(readonly config: IndexerConfig) {
		const { db, deployment } = config;
		this.trie = createIndexerTrie(deployment.kind, deployment.layout, db);
		this.syncedBlock = Number(db.getState("syncedBlock") ?? deployment.registrarCreatedAtBlock - 1);
		const aside = db.useCommitKind(deployment.kind);
		if (aside) this.log.warn(`${aside} commits of another commit source set aside (${deployment.kind} now)`);
		// replay the changes the trie doesn't have yet, capturing retained commits on the way
		const retained = this.retainedCommits();
		this.trie.retain(new Set(retained.map((c) => c.id)));
		const wanted = new Map<number, Commit[]>(); // changeSeq => commits
		for (const c of retained) {
			if (this.trie.has(c.id) || c.changeSeq < this.trie.seq) continue;
			const v = wanted.get(c.changeSeq);
			if (v) v.push(c);
			else wanted.set(c.changeSeq, [c]);
		}
		this.changeSeq = this.trie.seq;
		const capture = () => {
			for (const c of wanted.get(this.changeSeq) ?? []) this.trie.capture(c);
		};
		capture();
		const first = this.changeSeq;
		const last = db.lastChangeSeq();
		const rebuild = new Progress("rebuilding the trie: change", first, last, (...a) => this.log(...a), "changes");
		for (const c of db.iterateChanges(this.changeSeq)) {
			this.trie.apply(c);
			this.changeSeq = c.seq;
			capture();
			rebuild.update(c.seq);
		}
		if (last > first) this.log(`rebuilt the trie: ${n(last - first)} changes from the change log (${rebuild.elapsed})`);
		const missing = retained.filter((c) => !this.trie.has(c.id)).length;
		if (missing) this.log.warn(`${missing} retained commits are older than the stored trie (not served)`);
	}

	get db(): IndexerDB {
		return this.config.db;
	}

	get log(): Log {
		this.#log ??= toLog(this.config.log);
		return this.#log;
	}
	#log: Log | undefined;

	// commits whose tries are kept: all pending + recent valid
	private retainedCommits(): Commit[] {
		const { db, retainValid = 24 } = this.config;
		return [...db.getCommits("pending", 1_000_000), ...db.getCommits("valid", retainValid)];
	}

	status(): IndexerStatus {
		const { db, deployment } = this.config;
		const [latest] = db.getCommits("valid", 1);
		const { namesSlot, ownerSlot } = deployment.layout;
		return {
			chain: this.config.chain,
			kind: deployment.kind,
			l1ChainId: deployment.l1.id,
			l2ChainId: deployment.l2.id,
			l2BlockMs: "l2Blocks" in deployment ? deployment.l2Blocks[deployment.l2Blocks.length - 1].ms : undefined,
			...this.config.source.status?.(),
			registrar: deployment.L2ReverseRegistrar,
			layout: { namesSlot: Number(namesSlot), ownerSlot: ownerSlot === undefined ? undefined : Number(ownerSlot) },
			syncedBlock: this.syncedBlock,
			syncingTo: this.syncingTo,
			changeSeq: this.changeSeq,
			commits: db.countCommits(),
			latestValid: latest && {
				id: latest.id,
				l2Block: latest.l2Block,
				changeSeq: latest.changeSeq,
				validAt: latest.validAt,
			},
		};
	}

	// valid commits whose tries were dropped (another source used the database, or minAgeSec changed)
	private keepTries() {
		if (this.config.deployment.kind === "linea") return; // Linea's trie takes commits only in order
		for (const c of this.db.getCommits("valid", this.config.retainValid ?? 24)) this.keepTrie(c);
	}

	// Keep the trie of a stored commit whose trie was dropped (it stopped being retained, and is valid
	// again): rebuilt from the newest trie and checked against the commit's storage hash.
	keepTrie(c: Commit) {
		if (this.trie.has(c.id)) return;
		const storageHash = this.trie.storageHashAt(c);
		if (storageHash !== c.storageHash) {
			throw new Error(`commit ${c.id}: rebuilt storage hash ${storageHash}, expected ${c.storageHash}`);
		}
		this.trie.capture(c);
		this.log(`${commitName(c.kind)} ${c.id}: trie rebuilt (L2 block ${c.l2Block})`);
	}

	async tick() {
		this.keepTries(); // first: it needs no RPC
		await this.catchUp();
		await this.config.source.tick(this);
		this.keepTries();
		this.trie.retain(new Set(this.retainedCommits().map((c) => c.id)));
	}

	// rows of a retained commit (paged), or undefined
	snapshot(id: number, after: string | undefined, limit: number): RowPage | undefined {
		return this.trie.snapshot(id, after, limit);
	}

	// rows that turn retained commit `from` into `to`, or undefined
	patch(from: number, to: number): TrieRow[] | undefined {
		return this.trie.patch(from, to);
	}

	// Store a commit after checking the replayed storage hash against the L2's.
	// That check catches any storage write the events don't cover.
	// The change log is append-only, so it only ever contains final L2 blocks.
	async addCommit(commit: Omit<Commit, "changeSeq">, l2StorageHash: Hex) {
		const { l2Block, id } = commit;
		const finalized = await this.config.l2.finalizedBlock?.();
		if (finalized && l2Block > finalized.number) {
			throw new NotFinalizedError(`L2 block ${l2Block} is above the finalized head ${finalized.number}`);
		}
		let storageHash: Hex;
		let changeSeq: number;
		if (l2Block >= this.syncedBlock) {
			try {
				await this.syncChanges(l2Block);
			} catch (err) {
				throw new SyncError(`syncing events to L2 block ${l2Block}: ${errorMessage(err)}`, { cause: err });
			}
			storageHash = this.trie.storageHash();
			changeSeq = this.changeSeq;
		} else {
			// an older block than we've synced (out-of-order commit): the trie rebuilds that version
			changeSeq = this.db.changeSeqAtBlock(l2Block);
			storageHash = this.trie.storageHashAt({ id, l2Block, changeSeq });
		}
		if (storageHash !== l2StorageHash) {
			throw new Error(
				`storage hash mismatch at L2 block ${l2Block}: events=${storageHash} l2=${l2StorageHash} (missed a storage write?)`,
			);
		}
		if (!this.trie.has(id)) this.trie.capture({ id, l2Block, changeSeq });
		this.db.putCommit({ ...commit, changeSeq } as Commit);
		(commit.status === "valid" ? this.log.ok : this.log)(
			`${commitName(commit.kind)} ${id}: L2 block ${l2Block}, ${changeSeq} changes, storageHash ${storageHash} (${commit.status})`,
		);
	}

	// Sync events to near the L2's finalized head, so a new or stopped indexer replays them now instead
	// of at its first commit. It stops short so new commits stay ahead of it: an older commit is rebuilt
	// from the newest trie. Linea's trie takes commits only in order, so Linea syncs at each commit.
	async catchUp() {
		const { deployment, l2, catchUpBlocks = 10_000 } = this.config;
		if (deployment.kind === "linea" || !l2.finalizedBlock) return;
		const target = (await l2.finalizedBlock()).number - catchUpBlocks;
		if (target <= this.syncedBlock) return;
		const from = this.syncedBlock;
		const before = this.changeSeq;
		const t0 = Date.now();
		this.log(`catching up: L2 blocks ${n(from + 1)} to ${n(target)} (${n(target - from)} blocks)`);
		await this.syncChanges(target, false);
		this.log.ok(
			`caught up: +${n(this.changeSeq - before)} changes in ${n(this.syncedBlock - from)} blocks (${duration((Date.now() - t0) / 1000)}), ${n(this.changeSeq)} through L2 block ${n(this.syncedBlock)}`,
		);
	}

	private async syncChanges(toBlock: number, summary = true) {
		const first = this.changeSeq;
		const progress = new Progress("syncing events: L2 block", this.syncedBlock, toBlock, (...a) => this.log(...a));
		this.syncingTo = toBlock;
		const stop = progress.heartbeat(() => progress.update(this.syncedBlock, `${n(this.changeSeq - first)} changes`));
		try {
			await this.syncTo(toBlock, progress, first);
		} finally {
			stop();
			this.syncingTo = undefined;
		}
		const count = this.changeSeq - first;
		if (count && summary)
			this.log(`synced ${n(count)} changes through L2 block ${n(this.syncedBlock)} (${progress.elapsed})`);
	}

	private async syncTo(toBlock: number, progress: Progress, first: number) {
		const { db, l2 } = this.config;
		while (this.syncedBlock < toBlock) {
			const result = await l2.getChanges(this.syncedBlock + 1, toBlock);
			const changes: Change[] = result.changes.map((c, i) => ({ seq: this.changeSeq + i + 1, ...c }));
			db.db.transaction(() => {
				db.insertChanges(changes);
				db.setState("syncedBlock", result.toBlock);
			})();
			for (const c of changes) this.trie.apply(c);
			if (changes.length) this.changeSeq = changes[changes.length - 1].seq;
			this.syncedBlock = result.toBlock;
			progress.update(this.syncedBlock, `${n(this.changeSeq - first)} changes`);
		}
	}
}

// what each source calls its commits, in logs
export function commitName(kind: CommitKind): string {
	return { op: "game", inbox: "batch", arbitrum: "assertion", linea: "finalization" }[kind];
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
