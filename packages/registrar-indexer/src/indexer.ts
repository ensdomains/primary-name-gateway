import {
	ASR_ABI,
	type Change,
	type Commit,
	decodeGameClaim,
	FACTORY_ABI,
	GAME_ABI,
	GAME_STATUS_CHALLENGER_WINS,
	hashOutputRootProof,
	type IndexerStatus,
	type OPDeployment,
	type OutputRootProof,
	setPrimaryName,
} from "@primary-name-gateway/shared";
import { EthStorage, type MaybeNode } from "@ensdomains/merkle-builder";
import { type Address, type Hex, hexToBytes, type PublicClient, zeroHash } from "viem";
import type { IndexerDB } from "./db.js";
import type { L2Reader } from "./l2.js";

export type IndexerConfig = {
	deployment: OPDeployment;
	l1: PublicClient;
	l2: L2Reader;
	db: IndexerDB;
	lookbackSec: number; // on first start, index games created this long ago
	minFinalAgeSec: number; // don't ask if a game is valid until it is at least this old
	maxAttempts: number; // give up on a game after this many failures
	retainValid?: number; // keep tries of this many recent valid commits for /patch (default 24)
	log?: (...args: unknown[]) => void;
};

// Watches L1 for dispute games, snapshots the L2 registrar at each game's L2 block,
// and tracks when those games become valid claims.
//
// Invariant: `storage` is the registrar trie after all changes in blocks <= `syncedBlock`.
export class RegistrarIndexer {
	readonly storage = new EthStorage();
	syncedBlock: number;
	changeSeq: number;
	private readonly attempts = new Map<number, number>();
	private factory: Address | undefined;
	// trie at each retained commit (copy-on-write: unchanged subtrees are shared)
	private readonly roots = new Map<number, MaybeNode>();

	constructor(readonly config: IndexerConfig) {
		const { db, deployment } = config;
		this.syncedBlock = Number(db.getState("syncedBlock") ?? deployment.registrarCreatedAtBlock - 1);
		this.changeSeq = 0;
		// replay the change log, capturing the trie at each retained commit
		const wanted = new Map<number, number[]>(); // changeSeq => gameIndex[]
		for (const c of this.retainedCommits()) {
			const v = wanted.get(c.changeSeq);
			if (v) v.push(c.gameIndex);
			else wanted.set(c.changeSeq, [c.gameIndex]);
		}
		const capture = () => {
			for (const g of wanted.get(this.changeSeq) ?? []) this.roots.set(g, this.storage.node);
		};
		capture();
		for (const c of db.iterateChanges()) {
			setPrimaryName(this.storage, c.addr, hexToBytes(c.name));
			this.changeSeq = c.seq;
			capture();
		}
	}

	// commits whose tries are kept: all pending + recent valid
	private retainedCommits(): Commit[] {
		const { db, retainValid = 24 } = this.config;
		return [...db.getCommits("pending", 1_000_000), ...db.getCommits("valid", retainValid)];
	}

	// trie of a retained commit (undefined node = empty trie), or undefined if not retained
	rootOf(gameIndex: number): { node: MaybeNode } | undefined {
		return this.roots.has(gameIndex) ? { node: this.roots.get(gameIndex) } : undefined;
	}

	private pruneRoots() {
		const keep = new Set(this.retainedCommits().map((c) => c.gameIndex));
		for (const g of this.roots.keys()) if (!keep.has(g)) this.roots.delete(g);
	}

	private log(...args: unknown[]) {
		this.config.log?.(...args);
	}

	status(): IndexerStatus {
		const { db, deployment } = this.config;
		const [latest] = db.getCommits("valid", 1);
		return {
			chainId: deployment.l2.id,
			registrar: deployment.L2ReverseRegistrar,
			syncedBlock: this.syncedBlock,
			changeSeq: this.changeSeq,
			commits: db.countCommits(),
			latestValid: latest && {
				gameIndex: latest.gameIndex,
				l2Block: latest.l2Block,
				l2SequenceNumber: latest.l2SequenceNumber,
				changeSeq: latest.changeSeq,
				validAt: latest.validAt,
			},
		};
	}

	async tick() {
		await this.discoverGames();
		await this.refreshStatuses();
		this.pruneRoots();
	}

	// -- games

	private async getFactory(): Promise<Address> {
		this.factory ??= await this.config.l1.readContract({
			address: this.config.deployment.AnchorStateRegistry,
			abi: ASR_ABI,
			functionName: "disputeGameFactory",
		});
		return this.factory;
	}

	private async discoverGames() {
		const { l1, db, deployment } = this.config;
		const factory = await this.getFactory();
		const [count, respectedGameType] = await Promise.all([
			l1.readContract({ address: factory, abi: FACTORY_ABI, functionName: "gameCount" }).then(Number),
			l1.readContract({ address: deployment.AnchorStateRegistry, abi: ASR_ABI, functionName: "respectedGameType" }),
		]);
		let next = Number(db.getState("nextGameIndex") ?? -1);
		if (next < 0) {
			next = await this.findLookbackIndex(factory, count);
			db.setState("nextGameIndex", next);
		}
		for (; next < count; next++) {
			const [gameType, timestamp, game] = await l1.readContract({
				address: factory,
				abi: FACTORY_ABI,
				functionName: "gameAtIndex",
				args: [BigInt(next)],
			});
			if (gameType === respectedGameType) {
				try {
					await this.indexGame(next, game, gameType, Number(timestamp));
				} catch (err) {
					const n = (this.attempts.get(next) ?? 0) + 1;
					this.attempts.set(next, n);
					if (n < this.config.maxAttempts) {
						this.log(`game ${next}: attempt ${n} failed:`, errorMessage(err));
						break; // retry next tick
					}
					this.log(`game ${next}: skipped after ${n} attempts:`, errorMessage(err));
					db.putSkipped(next, game, errorMessage(err));
				}
			}
			db.setState("nextGameIndex", next + 1);
		}
	}

	// first game index created within the lookback window
	private async findLookbackIndex(factory: Address, count: number): Promise<number> {
		const since = (await this.l1Time()) - this.config.lookbackSec;
		let lo = 0;
		let hi = count;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const [, timestamp] = await this.config.l1.readContract({
				address: factory,
				abi: FACTORY_ABI,
				functionName: "gameAtIndex",
				args: [BigInt(mid)],
			});
			if (Number(timestamp) < since) lo = mid + 1;
			else hi = mid;
		}
		this.log(`starting at game ${lo} (${count - lo} games in lookback)`);
		return lo;
	}

	private async indexGame(gameIndex: number, game: Address, gameType: number, createdAt: number) {
		const { l1, l2, db, deployment } = this.config;
		const [rootClaim, extraData, l2SequenceNumber] = await Promise.all([
			l1.readContract({ address: game, abi: GAME_ABI, functionName: "rootClaim" }),
			l1.readContract({ address: game, abi: GAME_ABI, functionName: "extraData" }),
			l1.readContract({ address: game, abi: GAME_ABI, functionName: "l2SequenceNumber" }),
		]);
		const claim = decodeGameClaim(rootClaim, extraData, deployment.l2.id);
		if (!claim) {
			db.putSkipped(gameIndex, game, "undecodable claim");
			this.log(`game ${gameIndex}: undecodable claim`);
			return;
		}
		const l2Block =
			claim.kind === "output" ? Number(claim.l2BlockNumber) : await l2.blockAtTimestamp(claim.timestamp);

		// the parts of the proof that can't be rebuilt from events (must be fetched while L2 state is available)
		const witness = await l2.getBlockWitness(l2Block);
		const outputRootProof: OutputRootProof = {
			version: zeroHash,
			stateRoot: witness.stateRoot,
			messagePasserStorageRoot: witness.messagePasserStorageRoot,
			latestBlockhash: witness.blockHash,
		};
		const base = {
			gameIndex,
			game,
			gameType,
			createdAt,
			l2SequenceNumber: l2SequenceNumber.toString(),
			l2Block,
			superRoot: claim.kind === "super" ? claim.superRoot : "0x",
			outputRootProof,
			accountProof: witness.accountProof,
			storageHash: witness.storageHash,
		} as const;
		if (hashOutputRootProof(outputRootProof) !== claim.outputRoot) {
			// a bad proposal: it should lose, but we never serve it either way
			db.putCommit({ ...base, changeSeq: 0, status: "invalid" });
			this.log(`game ${gameIndex}: output root mismatch at L2 block ${l2Block} (invalid proposal)`);
			return;
		}

		const { node, storageHash, changeSeq } = await this.trieAt(l2Block);
		if (storageHash !== witness.storageHash) {
			throw new Error(
				`storage hash mismatch at L2 block ${l2Block}: events=${storageHash} l2=${witness.storageHash} (missed a storage write?)`,
			);
		}
		db.putCommit({ ...base, changeSeq, status: "pending" });
		this.roots.set(gameIndex, node);
		this.log(`game ${gameIndex}: L2 block ${l2Block}, ${changeSeq} changes, storageHash ${storageHash}`);
	}

	// -- changes

	// storage hash after all changes in blocks <= block
	private async trieAt(block: number): Promise<{ node: MaybeNode; storageHash: Hex; changeSeq: number }> {
		if (block >= this.syncedBlock) {
			await this.syncChanges(block);
			return { node: this.storage.node, storageHash: this.storage.storageHash, changeSeq: this.changeSeq };
		}
		// an older block than we've synced (out-of-order game): rebuild from the log
		const changeSeq = this.config.db.changeSeqAtBlock(block);
		const storage = new EthStorage();
		for (const c of this.config.db.iterateChanges(0, changeSeq)) {
			setPrimaryName(storage, c.addr, hexToBytes(c.name));
		}
		return { node: storage.node, storageHash: storage.storageHash, changeSeq };
	}

	private async syncChanges(toBlock: number) {
		const { db, l2 } = this.config;
		while (this.syncedBlock < toBlock) {
			const result = await l2.getNameChanges(this.syncedBlock + 1, toBlock);
			const changes: Change[] = result.changes.map((c, i) => ({ seq: this.changeSeq + i + 1, ...c }));
			db.db.transaction(() => {
				db.insertChanges(changes);
				db.setState("syncedBlock", result.toBlock);
			})();
			for (const c of changes) setPrimaryName(this.storage, c.addr, hexToBytes(c.name));
			if (changes.length) this.changeSeq = changes[changes.length - 1].seq;
			this.syncedBlock = result.toBlock;
			if (changes.length) this.log(`synced ${changes.length} changes through L2 block ${result.toBlock}`);
		}
	}

	// -- validity

	// L1 time (game timestamps are L1 block timestamps)
	private async l1Time(): Promise<number> {
		const block = await this.config.l1.getBlock({ blockTag: "latest" });
		return Number(block.timestamp);
	}

	private async refreshStatuses() {
		const { l1, db, deployment } = this.config;
		const now = await this.l1Time();
		// pending games old enough to be final + recent valid games (the guardian can still blacklist or retire them)
		const pending = [
			...db.getCommits("pending", 10000).filter((c) => c.createdAt + this.config.minFinalAgeSec <= now),
			...db.getCommits("valid", 4),
		];
		if (!pending.length) return;
		const asr = deployment.AnchorStateRegistry;
		const results = await Promise.all(
			pending.map((c) =>
				Promise.all([
					l1.readContract({ address: asr, abi: ASR_ABI, functionName: "isGameClaimValid", args: [c.game] }),
					l1.readContract({ address: asr, abi: ASR_ABI, functionName: "isGameBlacklisted", args: [c.game] }),
					l1.readContract({ address: c.game, abi: GAME_ABI, functionName: "status" }),
				]),
			),
		);
		pending.forEach((c, i) => {
			const [valid, blacklisted, status] = results[i];
			if (valid) {
				if (c.status === "valid") return;
				// wall-clock: the gateway compares this against its own clock
				db.putCommit({ ...c, status: "valid", validAt: Math.floor(Date.now() / 1000) });
				this.log(`game ${c.gameIndex}: valid (L2 block ${c.l2Block})`);
			} else if (c.status === "valid" || blacklisted || status === GAME_STATUS_CHALLENGER_WINS) {
				db.putCommit({ ...c, status: "invalid" });
				const reason = blacklisted ? "blacklisted" : status === GAME_STATUS_CHALLENGER_WINS ? "challenger wins" : "no longer valid";
				this.log(`game ${c.gameIndex}: invalid (${reason})`);
			}
		});
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
