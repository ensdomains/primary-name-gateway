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
	rawTransaction,
	transactionsTrieProof,
} from "@primary-name-gateway/shared";
import {
	type Address,
	BlockNotFoundError,
	bytesToHex,
	type Hex,
	hexToBytes,
	numberToHex,
	type PublicClient,
	parseAbi,
	type RpcTransaction,
	type Transaction,
} from "viem";
import { type CommitSource, errorMessage, NotFinalizedError, type RegistrarIndexer, SyncError } from "./indexer.js";
import { KZG } from "./kzg.js";
import { type InboxL2Reader, retryNotFound } from "./l2.js";

export type InboxSourceConfig = {
	deployment: InboxDeployment;
	l1: PublicClient;
	l2: InboxL2Reader;
	beaconURL: string; // GET /eth/v1/beacon/blobs (blobs are kept ~18 days)
	kzg: () => Promise<KZG>;
	intervalSec: number; // at most one commit per this many seconds of L1 time (KZG proofs are slow)
	scanBlocks: number; // L1 blocks to look back from the finalized head for a channel start
	firstScanBlocks: number; // the same with no commits yet: far enough back for a parent that is final
	maxL1BlockLag: number; // a commit is invalid once its L1 block is this many blocks old (the verifier's maxL1BlockLag)
	maxAttempts: number;
};

// a blob that starts a channel; id = l1Block * 10000 + txIndex * 10 + blobIndex
type InboxBatch = {
	id: number;
	block: { number: bigint; timestamp: bigint };
	tx: Transaction;
	blobIndex: number;
	blob: Uint8Array;
};

const SYSTEM_CONFIG_ABI = parseAbi(["function batcherHash() view returns (bytes32)"]);

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

// Commits from the batcher's posts (OPBatchInboxVerifier, docs/op-batch-inbox.md): a blob
// that starts a channel names its first batch's parent L2 block. Each commit carries everything the
// verifier needs: the L1 header, the transaction's trie proof, the blob's first field elements with
// KZG proofs, the parent L2 header and the registrar's account proof.
//
// Only finalized L1 blocks are used, and the parent must be at or below the L2's finalized head, so
// nothing stored can reorg. The newest batch's parent often isn't final yet (L2 finality follows L1's
// in 6.4 minute epochs), so the scan passes it over for the newest batch whose parent is. Commits are valid when found (the verifier trusts the batcher) until
// they're too old for the verifier, or the batcher is replaced.
export class InboxCommitSource implements CommitSource {
	private readonly attempts = new Map<number, number>();
	private beaconGenesis: bigint | undefined;

	constructor(readonly config: InboxSourceConfig) {}

	async tick(indexer: RegistrarIndexer) {
		const { l1, intervalSec, scanBlocks, firstScanBlocks } = this.config;
		const head = await l1.getBlock({ blockTag: "finalized" });
		const batcher = await this.batcher();
		this.invalidate(indexer, Number(head.number), batcher);
		const [last] = indexer.db.getCommits(undefined, 1);
		if (last && Number(head.timestamp) - last.createdAt < intervalSec) return;
		const depth = last ? scanBlocks : Math.max(scanBlocks, firstScanBlocks);
		let notFinal = 0;
		for await (const batch of this.channelStarts(indexer, head.number, depth, batcher)) {
			if (batch === "known") return; // nothing newer to commit
			const result = await this.tryCommit(indexer, batch);
			if (result !== "not final") return;
			notFinal++;
		}
		indexer.log.warn(
			notFinal
				? `${notFinal} channel starts in the last ${depth} finalized L1 blocks, none with a final parent yet`
				: `no channel start in the last ${depth} finalized L1 blocks`,
		);
	}

	// The batcher's channel starts, newest first, back `depth` L1 blocks from `head`; "known" (and the
	// end) at the first one committed or skipped before.
	private async *channelStarts(
		indexer: RegistrarIndexer,
		head: bigint,
		depth: number,
		batcher: Address,
	): AsyncGenerator<InboxBatch | "known"> {
		const { l1, deployment } = this.config;
		const inbox = deployment.BatchInbox.toLowerCase();
		for (let n = head; n > head - BigInt(depth); n--) {
			const block = await retryNotFound(() => l1.getBlock({ blockNumber: n, includeTransactions: true }));
			for (const tx of [...block.transactions].reverse()) {
				if (tx.to?.toLowerCase() !== inbox || tx.from.toLowerCase() !== batcher) continue;
				const hashes = tx.blobVersionedHashes ?? [];
				for (let blobIndex = 0; blobIndex < hashes.length; blobIndex++) {
					const id = Number(n) * 10000 + (tx.transactionIndex ?? 0) * 10 + blobIndex;
					if (indexer.db.getCommit(id) || indexer.db.isSkipped(id)) {
						yield "known";
						return;
					}
					const blob = await this.fetchBlob(block.timestamp, hashes[blobIndex]);
					if (startsChannel(blob)) yield { id, block, tx, blobIndex, blob };
				}
			}
		}
	}

	private async tryCommit(indexer: RegistrarIndexer, batch: InboxBatch): Promise<"committed" | "not final" | "later"> {
		const { id, tx } = batch;
		try {
			await this.indexCommit(indexer, batch);
			return "committed";
		} catch (err) {
			if (err instanceof NotFinalizedError) {
				indexer.log.warn(`batch ${id}: ${err.message}: trying an earlier batch`);
				return "not final";
			}
			if (err instanceof SyncError) {
				indexer.log.warn(`batch ${id}: waiting: ${err.message}`);
				return "later";
			}
			const n = (this.attempts.get(id) ?? 0) + 1;
			this.attempts.set(id, n);
			if (n < this.config.maxAttempts) {
				indexer.log.warn(`batch ${id}: attempt ${n} failed:`, errorMessage(err));
				return "later";
			}
			indexer.log.error(`batch ${id}: skipped after ${n} attempts:`, errorMessage(err));
			indexer.db.putSkipped(id, `${tx.hash}: ${errorMessage(err)}`);
			return "later";
		}
	}

	private async indexCommit(indexer: RegistrarIndexer, { id, block, tx, blobIndex, blob }: InboxBatch) {
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
		const l1Raw = await retryNotFound(async () => {
			const b = (await l1.request({
				method: "eth_getBlockByNumber",
				params: [numberToHex(block.number), true],
			} as never)) as (RpcBlockHeader & { transactions: RpcTransaction[] }) | null;
			if (!b) throw new BlockNotFoundError({ blockNumber: block.number });
			return b;
		});
		let raws = l1Raw.transactions.map(rawTransaction);
		let { root, proof: txProof } = transactionsTrieProof(raws, txIndex);
		if (root !== l1Raw.transactionsRoot) {
			// a transaction the re-encoding gets wrong (a new type?): ask for each one as signed
			raws = [];
			for (let i = 0; i < l1Raw.transactions.length; i += 25) {
				raws.push(
					...(await Promise.all(
						l1Raw.transactions
							.slice(i, i + 25)
							.map(
								(t) => l1.request({ method: "eth_getRawTransactionByHash", params: [t.hash] } as never) as Promise<Hex>,
							),
					)),
				);
			}
			({ root, proof: txProof } = transactionsTrieProof(raws, txIndex));
			if (root !== l1Raw.transactionsRoot) throw new Error("transactions root mismatch");
		}
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
			batcher: tx.from.toLowerCase() as Address,
			blobIndex,
			l2Hash: l2Raw.hash,
			batch: batch.type,
		};
		await indexer.addCommit(commit, account.storageHash);
	}

	// The verifier checks the sender against SystemConfig.batcherHash when it's called, so the batcher is
	// read at latest L1: after a rotation, the old batcher's commits stop verifying at once.
	private async batcher(): Promise<Address> {
		const { l1, deployment } = this.config;
		const batcherHash = await l1.readContract({
			address: deployment.SystemConfig,
			abi: SYSTEM_CONFIG_ABI,
			functionName: "batcherHash",
			blockTag: "latest",
		});
		return `0x${batcherHash.slice(-40)}`;
	}

	// commits the verifier would refuse: too old, or posted by a batcher that has since been replaced
	private invalidate(indexer: RegistrarIndexer, l1Head: number, batcher: Address) {
		for (const c of indexer.db.getCommits("valid", 1000)) {
			if (c.kind !== "inbox") continue;
			const reason =
				l1Head - c.l1Block > this.config.maxL1BlockLag
					? `L1 block ${c.l1Block} is too old`
					: c.batcher !== batcher
						? `the batcher is now ${batcher}`
						: undefined;
			if (!reason) continue;
			indexer.db.putCommit({ ...c, status: "invalid" });
			indexer.log.error(`batch ${c.id}: invalid (${reason})`);
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
