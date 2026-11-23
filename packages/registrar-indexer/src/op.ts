import {
	ASR_ABI,
	decodeGameClaim,
	encodeMPTProof,
	encodeOPFaultCommitProof,
	FACTORY_ABI,
	GAME_ABI,
	GAME_STATUS_CHALLENGER_WINS,
	GAME_STATUS_DEFENDER_WINS,
	GAME_TYPE_AGGREGATE_VERIFIER,
	hashOutputRootProof,
	type OPCommit,
	type OPDeployment,
	type OutputRootProof,
} from "@primary-name-gateway/shared";
import { type Address, type BlockTag, type PublicClient, zeroHash } from "viem";
import { type CommitSource, errorMessage, NotFinalizedError, type RegistrarIndexer, SyncError } from "./indexer.js";
import type { OPL2Reader } from "./l2.js";

export type OPSourceConfig = {
	deployment: OPDeployment;
	l1: PublicClient;
	l2: OPL2Reader;
	lookbackSec: number; // on first start, index games created this long ago
	minFinalAgeSec: number; // don't ask if a game is valid until it is at least this old
	maxAttempts: number; // give up on a game after this many failures
	// L1 state to trust for discovery and validity (default "finalized": games and their validity can't reorg)
	l1BlockTag?: BlockTag;
	// accept unchallenged games this old before they are finalized: must equal the verifier's minAgeSec (default 0: finalized only)
	minAgeSec?: number;
};

type GameResult = "done" | "deferred" | "retry";

// Watches L1 for dispute games of the respected type, snapshots the L2 registrar at each game's
// L2 block, and tracks when those games become valid claims.
//
// Reorgs: games are discovered from finalized L1 state, and a game whose L2 block isn't finalized
// yet is deferred (anyone can create a game for any block), so nothing the indexer stores can reorg.
export class OPCommitSource implements CommitSource {
	private readonly attempts = new Map<number, number>();
	private factory: Address | undefined;
	private resumed = false;

	constructor(readonly config: OPSourceConfig) {}

	async tick(indexer: RegistrarIndexer) {
		this.applyMinAge(indexer);
		await this.discoverGames(indexer);
		await this.refreshStatuses(indexer);
	}

	status() {
		return { minAgeSec: this.config.minAgeSec ?? 0 };
	}

	// Which games are valid depends on minAgeSec. When it changes, valid games go back to pending and
	// are checked again under the new rule: re-checked as valid games, games accepted early would be
	// marked invalid for good.
	private applyMinAge(indexer: RegistrarIndexer) {
		const { db } = indexer;
		const minAgeSec = String(this.config.minAgeSec ?? 0);
		const prev = db.getState("minAgeSec");
		if (prev === minAgeSec) return;
		if (prev !== undefined) {
			const valid = db.getCommits("valid", Number.MAX_SAFE_INTEGER);
			db.db.transaction(() => {
				for (const c of valid) db.putCommit({ ...c, status: "pending", validAt: undefined });
			})();
			indexer.log(`minAgeSec ${prev} → ${minAgeSec}: checking ${valid.length} valid games again`);
		}
		db.setState("minAgeSec", minAgeSec);
	}

	private async getFactory(): Promise<Address> {
		this.factory ??= await this.config.l1.readContract({
			address: this.config.deployment.AnchorStateRegistry,
			abi: ASR_ABI,
			functionName: "disputeGameFactory",
		});
		return this.factory;
	}

	private get l1BlockTag(): BlockTag {
		return this.config.l1BlockTag ?? "finalized";
	}

	private async discoverGames(indexer: RegistrarIndexer) {
		const { l1, deployment } = this.config;
		const { db } = indexer;
		const blockTag = this.l1BlockTag;
		const factory = await this.getFactory();
		const [count, respectedGameType] = await Promise.all([
			l1.readContract({ address: factory, abi: FACTORY_ABI, functionName: "gameCount", blockTag }).then(Number),
			l1.readContract({
				address: deployment.AnchorStateRegistry,
				abi: ASR_ABI,
				functionName: "respectedGameType",
				blockTag,
			}),
		]);
		let next = Number(db.getState("nextGameIndex") ?? -1);
		// on first start, and when resuming far behind (downtime, or the other commit source used the
		// database meanwhile): games older than the lookback can't be served, so skip them
		if (next < 0 || !this.resumed) {
			this.resumed = true;
			const lookback = await this.findLookbackIndex(indexer, factory, count, next);
			if (lookback > next) {
				next = lookback;
				db.setState("nextGameIndex", next);
			}
		}
		// games waiting for their L2 block to be finalized
		const deferred: number[] = JSON.parse(db.getState("deferredGames") ?? "[]");
		const waiting: number[] = [];
		for (const id of deferred) {
			if ((await this.tryGame(indexer, factory, respectedGameType, id)) !== "done") waiting.push(id);
		}
		for (; next < count; next++) {
			const result = await this.tryGame(indexer, factory, respectedGameType, next);
			if (result === "retry") break; // retry next tick, in order
			if (result === "deferred") waiting.push(next);
			db.setState("nextGameIndex", next + 1);
		}
		db.setState("deferredGames", JSON.stringify(waiting));
	}

	private async tryGame(
		indexer: RegistrarIndexer,
		factory: Address,
		respectedGameType: number,
		id: number,
	): Promise<GameResult> {
		const [gameType, timestamp, game] = await this.config.l1.readContract({
			address: factory,
			abi: FACTORY_ABI,
			functionName: "gameAtIndex",
			args: [BigInt(id)],
			blockTag: this.l1BlockTag,
		});
		if (gameType !== respectedGameType) return "done";
		try {
			await this.indexGame(indexer, id, game, gameType, Number(timestamp));
			return "done";
		} catch (err) {
			if (err instanceof SyncError) {
				indexer.log(`game ${id}: waiting for event sync: ${err.message}`);
				return "retry";
			}
			if (err instanceof NotFinalizedError) {
				indexer.log(`game ${id}: deferred: ${err.message}`);
				return "deferred";
			}
			const n = (this.attempts.get(id) ?? 0) + 1;
			this.attempts.set(id, n);
			if (n < this.config.maxAttempts) {
				indexer.log(`game ${id}: attempt ${n} failed:`, errorMessage(err));
				return "retry";
			}
			indexer.log(`game ${id}: skipped after ${n} attempts:`, errorMessage(err));
			indexer.db.putSkipped(id, `${game}: ${errorMessage(err)}`);
			return "done";
		}
	}

	// first game index created within the lookback window
	private async findLookbackIndex(
		indexer: RegistrarIndexer,
		factory: Address,
		count: number,
		next: number,
	): Promise<number> {
		const since = (await this.l1Time()) - this.config.lookbackSec;
		let lo = Math.max(0, next);
		let hi = count;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const [, timestamp] = await this.config.l1.readContract({
				address: factory,
				abi: FACTORY_ABI,
				functionName: "gameAtIndex",
				args: [BigInt(mid)],
				blockTag: this.l1BlockTag,
			});
			if (Number(timestamp) < since) lo = mid + 1;
			else hi = mid;
		}
		if (lo > next) indexer.log(`starting at game ${lo} (${count - lo} games in lookback)`);
		return lo;
	}

	private async indexGame(indexer: RegistrarIndexer, id: number, game: Address, gameType: number, createdAt: number) {
		const { l1, l2, deployment } = this.config;
		const [rootClaim, extraData, l2SequenceNumber] = await Promise.all([
			l1.readContract({ address: game, abi: GAME_ABI, functionName: "rootClaim" }),
			l1.readContract({ address: game, abi: GAME_ABI, functionName: "extraData" }),
			l1.readContract({ address: game, abi: GAME_ABI, functionName: "l2SequenceNumber" }),
		]);
		const claim = decodeGameClaim(rootClaim, extraData, deployment.l2.id);
		if (!claim) {
			indexer.db.putSkipped(id, `${game}: undecodable claim`);
			indexer.log(`game ${id}: undecodable claim`);
			return;
		}
		// only snapshot final L2 state: the change log is append-only
		const finalized = await l2.finalizedBlock();
		if (claim.kind === "output" ? claim.l2BlockNumber > finalized.number : claim.timestamp > finalized.timestamp) {
			throw new NotFinalizedError(
				`claims L2 ${claim.kind === "output" ? `block ${claim.l2BlockNumber}` : `time ${claim.timestamp}`}, finalized is block ${finalized.number}`,
			);
		}
		const l2Block = claim.kind === "output" ? Number(claim.l2BlockNumber) : await l2.blockAtTimestamp(claim.timestamp);

		// the parts of the proof that can't be rebuilt from events (must be fetched while L2 state is available)
		const witness = await l2.getBlockWitness(l2Block);
		const outputRootProof: OutputRootProof = {
			version: zeroHash,
			stateRoot: witness.stateRoot,
			messagePasserStorageRoot: witness.messagePasserStorageRoot,
			latestBlockhash: witness.blockHash,
		};
		const superRoot = claim.kind === "super" ? claim.superRoot : "0x";
		const commit: Omit<OPCommit, "changeSeq"> = {
			id,
			kind: "op",
			game,
			gameType,
			createdAt,
			l2SequenceNumber: l2SequenceNumber.toString(),
			l2Block,
			superRoot,
			outputRootProof,
			storageHash: witness.storageHash,
			status: "pending",
			commitProof: encodeOPFaultCommitProof({ game, superRoot, outputRootProof }),
			accountProof: encodeMPTProof(witness.accountProof),
		};
		if (hashOutputRootProof(outputRootProof) !== claim.outputRoot) {
			// a bad proposal: it should lose, but we never serve it either way
			indexer.db.putCommit({ ...commit, changeSeq: 0, status: "invalid" });
			indexer.log(`game ${id}: output root mismatch at L2 block ${l2Block} (invalid proposal)`);
			return;
		}
		await indexer.addCommit(commit, witness.storageHash);
	}

	// L1 time (game timestamps are L1 block timestamps)
	private async l1Time(): Promise<number> {
		const block = await this.config.l1.getBlock({ blockTag: "latest" });
		return Number(block.timestamp);
	}

	// mirrors OPFaultVerifier.isGameAcceptable() at an L1 block
	private async isAcceptable(c: OPCommit, blockTag: BlockTag, time: number): Promise<boolean> {
		const { l1, deployment, minAgeSec = 0 } = this.config;
		const asr = deployment.AnchorStateRegistry;
		const valid = await l1.readContract({
			address: asr,
			abi: ASR_ABI,
			functionName: "isGameClaimValid",
			args: [c.game],
			blockTag,
		});
		if (valid) return true;
		if (!minAgeSec) return false;
		const [proper, respected, status] = await Promise.all([
			l1.readContract({ address: asr, abi: ASR_ABI, functionName: "isGameProper", args: [c.game], blockTag }),
			l1.readContract({ address: asr, abi: ASR_ABI, functionName: "isGameRespected", args: [c.game], blockTag }),
			l1.readContract({ address: c.game, abi: GAME_ABI, functionName: "status", blockTag }),
		]);
		if (!proper || !respected || status === GAME_STATUS_CHALLENGER_WINS) return false;
		if (status === GAME_STATUS_DEFENDER_WINS) return true;
		if (c.createdAt + minAgeSec > time) return false;
		try {
			if (c.gameType === GAME_TYPE_AGGREGATE_VERIFIER) {
				const n = await l1.readContract({
					address: c.game,
					abi: GAME_ABI,
					functionName: "counteredByIntermediateRootIndexPlusOne",
					blockTag,
				});
				return n === 0n;
			}
			return (await l1.readContract({ address: c.game, abi: GAME_ABI, functionName: "claimDataLen", blockTag })) === 1n;
		} catch {
			return false;
		}
	}

	private async refreshStatuses(indexer: RegistrarIndexer) {
		const { l1, deployment, minFinalAgeSec, minAgeSec = 0 } = this.config;
		const retainValid = indexer.config.retainValid ?? 24;
		const { db } = indexer;
		const finalTag = this.l1BlockTag;
		const [latest, final] = await Promise.all([
			l1.getBlock({ blockTag: "latest" }),
			finalTag === "latest" ? undefined : l1.getBlock({ blockTag: finalTag }),
		]);
		const now = Number(latest.timestamp);
		const finalTime = final ? Number(final.timestamp) : now;
		// pending games old enough to become acceptable + the valid games a gateway may still hold
		// (they can still be blacklisted, retired, challenged or lost)
		const pollAge = minAgeSec > 0 ? minAgeSec : minFinalAgeSec;
		const candidates = [
			...db.getCommits("pending", 10000).filter((c) => c.createdAt + pollAge <= now),
			...db.getCommits("valid", retainValid),
		].filter((c): c is OPCommit => c.kind === "op");
		if (!candidates.length) return;
		const asr = deployment.AnchorStateRegistry;
		const results = await Promise.all(
			candidates.map((c) =>
				Promise.all([
					// acceptable on finalized L1 (can't be reorged away) and still acceptable now
					this.isAcceptable(c, finalTag, finalTime),
					this.isAcceptable(c, "latest", now),
					// invalidation reacts to the latest state
					l1.readContract({ address: asr, abi: ASR_ABI, functionName: "isGameBlacklisted", args: [c.game] }),
					l1.readContract({ address: c.game, abi: GAME_ABI, functionName: "status" }),
				]),
			),
		);
		candidates.forEach((c, i) => {
			const [acceptableFinal, acceptableNow, blacklisted, status] = results[i];
			if (acceptableFinal && acceptableNow) {
				if (c.status === "valid") return;
				// wall-clock: the gateway compares this against its own clock
				db.putCommit({ ...c, status: "valid", validAt: Math.floor(Date.now() / 1000) });
				indexer.log(`game ${c.id}: valid (L2 block ${c.l2Block})`);
			} else if ((c.status === "valid" && !acceptableNow) || blacklisted || status === GAME_STATUS_CHALLENGER_WINS) {
				db.putCommit({ ...c, status: "invalid" });
				const reason = blacklisted
					? "blacklisted"
					: status === GAME_STATUS_CHALLENGER_WINS
						? "challenger wins"
						: "no longer acceptable (challenged, retired or paused)";
				indexer.log(`game ${c.id}: invalid (${reason})`);
			}
		});
	}
}
