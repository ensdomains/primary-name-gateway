import {
	encodeLineaMultiProof,
	type LineaCommit,
	type LineaDeployment,
	lineaAccountKey,
	lineaAccountValueHash,
	lineaMultiProofFromPath,
	lineaMultiProofRoot,
} from "@primary-name-gateway/shared";
import {
	type BlockTag,
	bytesToHex,
	encodeAbiParameters,
	getAbiItem,
	type Hex,
	hexToBytes,
	type PublicClient,
	parseAbi,
} from "viem";
import { type CommitSource, errorMessage, type RegistrarIndexer, SyncError } from "./indexer.js";
import type { LineaL2Reader } from "./l2.js";

export const LINEA_ROLLUP_ABI = parseAbi([
	"event DataFinalizedV3(uint256 indexed startBlockNumber, uint256 indexed endBlockNumber, bytes32 indexed shnarf, bytes32 parentStateRootHash, bytes32 finalStateRootHash)",
	"function stateRootHashes(uint256) view returns (bytes32)",
	"function currentL2BlockNumber() view returns (uint256)",
]);
const DATA_FINALIZED = getAbiItem({ abi: LINEA_ROLLUP_ABI, name: "DataFinalizedV3" });

export type LineaSourceConfig = {
	deployment: LineaDeployment;
	l1: PublicClient;
	l2: LineaL2Reader;
	// on first start, scan finalizations this many L1 blocks back. Shomei only serves
	// linea_getProof for the last ~day of finalizations, so older ones can't be indexed anyway.
	lookbackBlocks: number;
	maxAttempts: number; // give up on a finalization after this many failures
	blockTag?: BlockTag; // L1 head to follow (default "finalized": no reorgs)
	logStep?: number; // L1 eth_getLogs range (default 10000)
};

// Watches LineaRollup for finalizations (ZK proven, final once the L1 block is) and snapshots
// the L2 registrar at each finalized L2 block: the commit is valid immediately.
export class LineaCommitSource implements CommitSource {
	private readonly attempts = new Map<number, number>();
	private logStep: number;

	constructor(readonly config: LineaSourceConfig) {
		this.logStep = config.logStep ?? 10000;
	}

	async tick(indexer: RegistrarIndexer) {
		const { l1, lookbackBlocks, maxAttempts, blockTag = "finalized" } = this.config;
		const { db } = indexer;
		const head = Number((await l1.getBlock({ blockTag })).number);
		let from = Number(db.getState("nextL1Block") ?? -1);
		if (from < 0) {
			from = Math.max(0, head - lookbackBlocks);
			db.setState("nextL1Block", from);
			indexer.log(`starting at L1 block ${from}`);
		}
		while (from <= head) {
			const to = Math.min(head, from + this.logStep - 1);
			let logs: Awaited<ReturnType<typeof this.getLogs>>;
			try {
				logs = await this.getLogs(from, to);
			} catch (err) {
				if (this.logStep <= 100) throw err;
				this.logStep >>= 1;
				continue;
			}
			for (const log of logs) {
				const id = Number(log.args.endBlockNumber);
				if (db.getCommit(id) || db.isSkipped(id)) continue;
				try {
					await this.indexFinalization(indexer, log);
				} catch (err) {
					if (err instanceof SyncError) {
						// not this finalization's fault: retry next tick without using up an attempt
						indexer.log.warn(`finalization ${id}: waiting for event sync: ${err.message}`);
						db.setState("nextL1Block", Number(log.blockNumber));
						return;
					}
					const n = (this.attempts.get(id) ?? 0) + 1;
					this.attempts.set(id, n);
					if (n < maxAttempts) {
						indexer.log.warn(`finalization ${id}: attempt ${n} failed:`, errorMessage(err));
						db.setState("nextL1Block", Number(log.blockNumber)); // retry next tick
						return;
					}
					indexer.log.error(`finalization ${id}: skipped after ${n} attempts:`, errorMessage(err));
					db.putSkipped(id, errorMessage(err));
				}
			}
			from = to + 1;
			db.setState("nextL1Block", from);
		}
	}

	private async getLogs(from: number, to: number) {
		const logs = await this.config.l1.getLogs({
			address: this.config.deployment.LineaRollup,
			event: DATA_FINALIZED,
			fromBlock: BigInt(from),
			toBlock: BigInt(to),
			strict: true,
		});
		return logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
	}

	private async indexFinalization(
		indexer: RegistrarIndexer,
		log: Awaited<ReturnType<LineaCommitSource["getLogs"]>>[number],
	) {
		const { l1, l2, deployment } = this.config;
		const l2Block = Number(log.args.endBlockNumber);
		const stateRoot = log.args.finalStateRootHash;
		const [proof, l1Block] = await Promise.all([
			l2.getAccountProof(l2Block),
			l1.getBlock({ blockNumber: log.blockNumber }),
		]);
		// the account proof must prove the registrar under the finalized state root
		const multi = lineaMultiProofFromPath(proof);
		if (lineaMultiProofRoot(multi) !== stateRoot) {
			throw new Error(`account proof at L2 block ${l2Block} doesn't match the finalized state root ${stateRoot}`);
		}
		const leaf = hexToBytes(multi.leaves[0]);
		const account = hexToBytes(proof.proof.value);
		if (
			bytesToHex(leaf.subarray(128, 160)) !== bytesToHex(lineaAccountKey(deployment.L2ReverseRegistrar)) ||
			bytesToHex(leaf.subarray(160, 192)) !== bytesToHex(lineaAccountValueHash(account))
		) {
			throw new Error(`account proof at L2 block ${l2Block} is not the registrar's`);
		}
		const storageHash = bytesToHex(account.subarray(64, 96)) as Hex;
		const commit: Omit<LineaCommit, "changeSeq"> = {
			id: l2Block,
			kind: "linea",
			createdAt: Number(l1Block.timestamp),
			l1Block: Number(log.blockNumber),
			l2Block,
			stateRoot,
			storageHash,
			status: "valid", // finalized
			validAt: Math.floor(Date.now() / 1000), // wall-clock: the gateway compares this against its own clock
			commitProof: encodeAbiParameters([{ type: "uint256" }], [BigInt(l2Block)]),
			accountProof: encodeLineaMultiProof(multi),
		};
		await indexer.addCommit(commit, storageHash);
	}
}
