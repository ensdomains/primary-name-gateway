import type { Change, Commit, Deployment, IndexerStatus, TrieRow } from "@primary-name-gateway/shared";
import type { Hex } from "viem";
import type { IndexerDB } from "./db.js";
import type { ChangeReader } from "./l2.js";
import { createIndexerTrie, type IndexerTrie, type RowPage } from "./tries.js";

// Finds commits on L1 and captures what the verifier will need from the L2 at that moment.
// OPCommitSource: dispute games, LineaCommitSource: finalizations.
export interface CommitSource {
	tick(indexer: RegistrarIndexer): Promise<void>;
}

export type IndexerConfig = {
	deployment: Deployment;
	l2: ChangeReader;
	source: CommitSource;
	db: IndexerDB;
	retainValid?: number; // keep tries of this many recent valid commits for /patch (default 24)
	log?: (...args: unknown[]) => void;
};

// Replays the L2 registrar's events into its storage trie and keeps the tries of recent commits.
//
// Invariant: `trie` is the registrar trie after all changes in blocks <= `syncedBlock`.
export class RegistrarIndexer {
	readonly trie: IndexerTrie;
	syncedBlock: number;
	changeSeq = 0;

	constructor(readonly config: IndexerConfig) {
		const { db, deployment } = config;
		this.trie = createIndexerTrie(deployment.kind, deployment.layout);
		this.syncedBlock = Number(db.getState("syncedBlock") ?? deployment.registrarCreatedAtBlock - 1);
		// replay the change log, capturing the trie at each retained commit
		const wanted = new Map<number, Commit[]>(); // changeSeq => commits
		for (const c of this.retainedCommits()) {
			const v = wanted.get(c.changeSeq);
			if (v) v.push(c);
			else wanted.set(c.changeSeq, [c]);
		}
		const capture = () => {
			for (const c of wanted.get(this.changeSeq) ?? []) this.trie.capture(c.id, c.l2Block);
		};
		capture();
		for (const c of db.iterateChanges()) {
			this.trie.apply(c);
			this.changeSeq = c.seq;
			capture();
		}
	}

	get db(): IndexerDB {
		return this.config.db;
	}

	log(...args: unknown[]) {
		this.config.log?.(...args);
	}

	// commits whose tries are kept: all pending + recent valid
	private retainedCommits(): Commit[] {
		const { db, retainValid = 24 } = this.config;
		return [...db.getCommits("pending", 1_000_000), ...db.getCommits("valid", retainValid)];
	}

	status(): IndexerStatus {
		const { db, deployment } = this.config;
		const [latest] = db.getCommits("valid", 1);
		return {
			chainId: deployment.l2.id,
			kind: deployment.kind,
			registrar: deployment.L2ReverseRegistrar,
			syncedBlock: this.syncedBlock,
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

	async tick() {
		await this.config.source.tick(this);
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
	async addCommit(commit: Omit<Commit, "changeSeq">, l2StorageHash: Hex) {
		const { l2Block, id } = commit;
		let storageHash: Hex;
		let changeSeq: number;
		if (l2Block >= this.syncedBlock) {
			await this.syncChanges(l2Block);
			storageHash = this.trie.storageHash();
			changeSeq = this.changeSeq;
		} else {
			// an older block than we've synced (out-of-order commit): rebuild from the log
			changeSeq = this.db.changeSeqAtBlock(l2Block);
			storageHash = this.trie.captureFrom(id, l2Block, this.db.iterateChanges(0, changeSeq));
		}
		if (storageHash !== l2StorageHash) {
			throw new Error(
				`storage hash mismatch at L2 block ${l2Block}: events=${storageHash} l2=${l2StorageHash} (missed a storage write?)`,
			);
		}
		if (!this.trie.has(id)) this.trie.capture(id, l2Block);
		this.db.putCommit({ ...commit, changeSeq } as Commit);
		this.log(`commit ${id}: L2 block ${l2Block}, ${changeSeq} changes, storageHash ${storageHash} (${commit.status})`);
	}

	private async syncChanges(toBlock: number) {
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
			if (changes.length) this.log(`synced ${changes.length} changes through L2 block ${result.toBlock}`);
		}
	}
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
