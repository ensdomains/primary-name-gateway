import {
	type BlockSchedule,
	blobDataPrefix,
	blocksAtTimestamp,
	brotliDecodePrefix,
	channelStart,
	decodeBatchPrefix,
	encodeBlockHeader,
	encodeMPTProof,
	encodeOPBatchInboxCommitProof,
	fieldElementsFor,
	type InboxCommit,
	type InboxDeployment,
	type RpcBlockHeader,
	transactionsTrieProof,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes, numberToHex, type PublicClient, parseAbi, type Transaction } from "viem";
import { type CommitSource, errorMessage, NotFinalizedError, type RegistrarIndexer, SyncError } from "./indexer.js";
import { KZG } from "./kzg.js";
import type { InboxL2Reader } from "./l2.js";

export type InboxSourceConfig = {
	deployment: InboxDeployment;
	l1: PublicClient;
	l2: InboxL2Reader;
	beaconURL: string; // GET /eth/v1/beacon/blobs (blobs are kept ~18 days)
	kzg: () => Promise<KZG>;
	intervalSec: number; // at most one commit per this many seconds of L1 time (KZG proofs are slow)
	scanBlocks: number; // L1 blocks to look back from the finalized head for a channel start
	maxBlockLag: number; // a commit is invalid once its L1 block is this many blocks old (the verifier's maxBlockLag)
	maxAttempts: number;
};

const SYSTEM_CONFIG_ABI = parseAbi(["function batcherHash() view returns (bytes32)"]);

// Commits from the batcher's posts (OPBatchInboxVerifier, research: docs/op-batch-inbox.md): a blob
// that starts a channel names its first batch's parent L2 block. Each commit carries everything the
// verifier needs: the L1 header, the transaction's trie proof, the blob's first field elements with
// KZG proofs, the parent L2 header and the registrar's account proof.
//
// Only finalized L1 blocks are used, and the parent must be at or below the L2's finalized head, so
// nothing stored can reorg. Commits are valid when found (the verifier trusts the batcher) until
// they're too old for the verifier.
// The parent of a span batch's first block. The batch gives that block's timestamp (relative to the
// rollup genesis) and the first 20 bytes of its parent's hash. With blocks under a second apart (Base
// since Denim) several blocks share the timestamp, and the parent check picks one.
export async function spanBatchParent(
	schedule: BlockSchedule,
	relTimestamp: bigint,
	parentCheck: string,
	header: (block: number) => Promise<RpcBlockHeader>,
): Promise<RpcBlockHeader> {
	const timestamp = schedule[0].timestamp + Number(relTimestamp);
	const range = blocksAtTimestamp(schedule, timestamp);
	if (!range) throw new Error(`no L2 block at timestamp ${timestamp}`);
	for (let first = range[0]; first <= range[1]; first++) {
		const parent = await header(first - 1);
		if (parent.hash.startsWith(parentCheck)) return parent;
	}
	throw new Error(`no L2 block at timestamp ${timestamp} has the parent ${parentCheck}`);
}

export class InboxCommitSource implements CommitSource {
	private readonly attempts = new Map<number, number>();
	private beaconGenesis: bigint | undefined;

	constructor(readonly config: InboxSourceConfig) {}

	async tick(indexer: RegistrarIndexer) {
		const { l1, deployment, intervalSec, scanBlocks } = this.config;
		const head = await l1.getBlock({ blockTag: "finalized" });
		this.expire(indexer, Number(head.number));
		const [last] = indexer.db.getCommits(undefined, 1);
		if (last && Number(head.timestamp) - last.createdAt < intervalSec) return;
		const batcherHash = await l1.readContract({
			address: deployment.SystemConfig,
			abi: SYSTEM_CONFIG_ABI,
			functionName: "batcherHash",
			blockTag: "finalized",
		});
		const batcher = `0x${batcherHash.slice(-40)}`;
		const inbox = deployment.BatchInbox.toLowerCase();
		// newest first: stop at the first channel start (indexed now, or already)
		for (let n = head.number; n > head.number - BigInt(scanBlocks); n--) {
			const block = await l1.getBlock({ blockNumber: n, includeTransactions: true });
			for (const tx of [...block.transactions].reverse()) {
				if (tx.to?.toLowerCase() !== inbox || tx.from.toLowerCase() !== batcher) continue;
				const hashes = tx.blobVersionedHashes ?? [];
				for (let b = 0; b < hashes.length; b++) {
					const id = Number(n) * 10000 + (tx.transactionIndex ?? 0) * 10 + b;
					if (indexer.db.getCommit(id) || indexer.db.isSkipped(id)) return;
					const blob = await this.fetchBlob(block.timestamp, hashes[b]);
					if (!startsChannel(blob)) continue;
					await this.tryCommit(indexer, id, block, tx, b, blob);
					return;
				}
			}
		}
		indexer.log(`no channel start in the last ${scanBlocks} finalized L1 blocks`);
	}

	private async tryCommit(
		indexer: RegistrarIndexer,
		id: number,
		block: { number: bigint; timestamp: bigint },
		tx: Transaction,
		blobIndex: number,
		blob: Uint8Array,
	) {
		try {
			await this.indexCommit(indexer, id, block, tx, blobIndex, blob);
		} catch (err) {
			if (err instanceof SyncError || err instanceof NotFinalizedError) {
				indexer.log(`batch ${id}: waiting: ${err.message}`);
				return;
			}
			const n = (this.attempts.get(id) ?? 0) + 1;
			this.attempts.set(id, n);
			if (n < this.config.maxAttempts) {
				indexer.log(`batch ${id}: attempt ${n} failed:`, errorMessage(err));
				return;
			}
			indexer.log(`batch ${id}: skipped after ${n} attempts:`, errorMessage(err));
			indexer.db.putSkipped(id, `${tx.hash}: ${errorMessage(err)}`);
		}
	}

	private async indexCommit(
		indexer: RegistrarIndexer,
		id: number,
		block: { number: bigint; timestamp: bigint },
		tx: Transaction,
		blobIndex: number,
		blob: Uint8Array,
	) {
		const { l1, l2, deployment } = this.config;
		const txIndex = tx.transactionIndex;
		if (txIndex === null) throw new Error("pending transaction");
		// the batch and its parent L2 block
		const { compressed } = channelStart(blobDataPrefix(blob));
		const { output, stats } = brotliDecodePrefix(compressed, 112);
		const batch = decodeBatchPrefix(output);
		let l2Raw: RpcBlockHeader;
		if (batch.type === "singular") {
			l2Raw = await l2.header(batch.parentHash);
		} else {
			l2Raw = await spanBatchParent(deployment.l2Blocks, batch.relTimestamp, batch.parentCheck, (n) => l2.header(n));
		}
		const l2Block = Number(BigInt(l2Raw.number));
		const finalized = await l2.finalizedBlock();
		if (l2Block > finalized.number) {
			throw new NotFinalizedError(`L2 block ${l2Block} is above the finalized head ${finalized.number}`);
		}
		const account = await l2.account(l2Block);
		// the L1 header and the transaction's proof
		const l1Raw = (await l1.request({
			method: "eth_getBlockByNumber",
			params: [numberToHex(block.number), false],
		} as never)) as RpcBlockHeader & { transactions: Hex[] };
		const raws: Hex[] = [];
		for (let i = 0; i < l1Raw.transactions.length; i += 25) {
			raws.push(
				...(await Promise.all(
					l1Raw.transactions
						.slice(i, i + 25)
						.map((h) => l1.request({ method: "eth_getRawTransactionByHash", params: [h] } as never) as Promise<Hex>),
				)),
			);
		}
		const { root, proof: txProof } = transactionsTrieProof(raws, txIndex);
		if (root !== l1Raw.transactionsRoot) throw new Error("transactions root mismatch");
		// the blob's first field elements (as many as the batch prefix needs) with KZG proofs
		const kzg = await this.config.kzg();
		const commitment = kzg.commitment(blob);
		if (KZG.versionedHash(commitment) !== tx.blobVersionedHashes![blobIndex])
			throw new Error("blob commitment mismatch");
		const n = fieldElementsFor(Math.ceil(stats.bits / 8));
		const blobProofs: Hex[] = [];
		for (let i = 0; i < n; i++) {
			blobProofs.push(kzg.proveFieldElement(blob, i));
			await Bun.sleep(0); // let the HTTP server answer between proofs
		}
		const commit: InboxCommit = {
			id,
			kind: "inbox",
			createdAt: Number(block.timestamp),
			l2Block,
			storageHash: account.storageHash,
			changeSeq: 0, // set by addCommit
			status: "valid",
			validAt: Math.floor(Date.now() / 1000),
			commitProof: encodeOPBatchInboxCommitProof({
				l1Header: encodeBlockHeader(l1Raw),
				txIndex,
				txProof,
				blobIndex,
				commitment,
				fieldElements: bytesToHex(blob.subarray(0, 32 * n)),
				blobProofs,
				l2Header: encodeBlockHeader(l2Raw),
			}),
			accountProof: encodeMPTProof(account.accountProof),
			l1Block: Number(block.number),
			tx: tx.hash,
			blobIndex,
			l2Hash: l2Raw.hash,
			batch: batch.type,
		};
		await indexer.addCommit(commit, account.storageHash);
	}

	// commits too old for the verifier
	private expire(indexer: RegistrarIndexer, l1Head: number) {
		for (const c of indexer.db.getCommits("valid", 1000)) {
			if (c.kind === "inbox" && l1Head - c.l1Block > this.config.maxBlockLag) {
				indexer.db.putCommit({ ...c, status: "invalid" });
				indexer.log(`commit ${c.id}: invalid (L1 block ${c.l1Block} is too old)`);
			}
		}
	}

	private async fetchBlob(timestamp: bigint, versionedHash: Hex): Promise<Uint8Array> {
		const { beaconURL } = this.config;
		if (this.beaconGenesis === undefined) {
			const res = await fetch(`${beaconURL}/eth/v1/beacon/genesis`);
			if (!res.ok) throw new Error(`beacon genesis: ${res.status}`);
			this.beaconGenesis = BigInt(((await res.json()) as { data: { genesis_time: string } }).data.genesis_time);
		}
		const slot = (timestamp - this.beaconGenesis) / 12n;
		const res = await fetch(`${beaconURL}/eth/v1/beacon/blobs/${slot}?versioned_hashes=${versionedHash}`);
		if (!res.ok) throw new Error(`beacon blobs ${slot}: ${res.status}`);
		const [blob] = ((await res.json()) as { data: Hex[] }).data;
		if (!blob) throw new Error(`beacon: no blob ${versionedHash} in slot ${slot}`);
		return hexToBytes(blob);
	}
}

// the blob's batcher data starts a brotli channel (derivation version 0, frame 0)
function startsChannel(blob: Uint8Array): boolean {
	try {
		channelStart(blobDataPrefix(blob.subarray(0, 128)));
		return true;
	} catch {
		return false;
	}
}
