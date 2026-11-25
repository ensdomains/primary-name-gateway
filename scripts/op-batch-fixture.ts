// Fixture for the batch inbox tests, from a real batcher transaction: the first field elements of its
// blob with their batched KZG proof (the indexer's, kzg.ts), the L1 header and the transaction's trie
// proof, the batch's parent L2 header, and the registrar's account proof at that L2 block.
//
//   bun scripts/op-batch-fixture.ts <base|op> <L1 block>   (blobs are kept ~18 days)
//
// The commitment must match the transaction's versioned hash, and the tests check the proof with the
// point evaluation precompile.

import { KZG } from "@primary-name-gateway/registrar-indexer";
import {
	beaconURL,
	blobDataPrefix,
	brotliDecodePrefix,
	channelStart,
	createClient,
	DEPLOYMENTS,
	decodeBatchPrefix,
	encodeBlockHeader,
	MAINNET,
	type RpcBlockHeader,
	rawTransaction,
	transactionsTrieProof,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes, numberToHex, parseAbi, type RpcTransaction } from "viem";

const FIELD_ELEMENTS = 64; // enough for both batch prefixes (fieldElementsFor: OP 64, Base 64)
const CHAINS = {
	base: {
		systemConfig: "0x73a79Fab69143498Ed3712e519A88a918e1f4072",
		inbox: "0xff00000000000000000000000000000000008453",
	},
	op: {
		systemConfig: "0x229047fed2591dbec1eF1118d64F7aF3dB9EB290",
		inbox: "0xff00000000000000000000000000000000000010",
	},
} as const;

const [chain, blockArg] = process.argv.slice(2) as [keyof typeof CHAINS, string];
if (!CHAINS[chain] || !blockArg) throw new Error("usage: op-batch-fixture.ts <base|op> <L1 block>");
const { systemConfig, inbox } = CHAINS[chain];

// -- the batcher's blob
const l1 = createClient(MAINNET);
const batcherHash = await l1.readContract({
	address: systemConfig,
	abi: parseAbi(["function batcherHash() view returns (bytes32)"]),
	functionName: "batcherHash",
});
const batcher = `0x${batcherHash.slice(-40)}`;
const block = await l1.getBlock({ blockNumber: BigInt(blockArg), includeTransactions: true });
const tx = block.transactions.find(
	(t) => t.to?.toLowerCase() === inbox && t.from.toLowerCase() === batcher && t.blobVersionedHashes?.length,
);
if (!tx?.blobVersionedHashes) throw new Error(`no batcher transaction in block ${blockArg}`);
const versionedHash = tx.blobVersionedHashes[0];
const slot = (block.timestamp - 1606824023n) / 12n;
const res = await fetch(`${beaconURL(MAINNET)}/eth/v1/beacon/blobs/${slot}?versioned_hashes=${versionedHash}`);
if (!res.ok) throw new Error(`beacon: ${res.status}`);
const blob = hexToBytes(((await res.json()) as { data: Hex[] }).data[0]);

// -- KZG
const kzg = await KZG.load();
const commitment = kzg.commitment(blob);
if (KZG.versionedHash(commitment) !== versionedHash) throw new Error("commitment doesn't match the versioned hash");
const blobProof = kzg.proveFieldElements(blob, commitment, FIELD_ELEMENTS);

// -- the L1 header and the transaction's proof in the block's transactions trie
const getBlock = (client: typeof l1, tag: Hex, byHash = false) =>
	client.request({
		method: byHash ? "eth_getBlockByHash" : "eth_getBlockByNumber",
		params: [tag, true],
	} as never) as Promise<RpcBlockHeader & { transactions: RpcTransaction[] }>;
const l1Raw = await getBlock(l1, numberToHex(block.number));
const l1Header = encodeBlockHeader(l1Raw);
const raws = l1Raw.transactions.map(rawTransaction);
const txIndex = tx.transactionIndex;
const { root: txRoot, proof: txProof } = transactionsTrieProof(raws, txIndex);
if (txRoot !== l1Raw.transactionsRoot) throw new Error("transactions root mismatch");

// -- the batch's parent L2 block, and the registrar's account proof there
const deployment = DEPLOYMENTS[chain === "op" ? "optimism" : "base"];
const l2 = createClient(deployment.l2, "proof");
const { compressed } = channelStart(blobDataPrefix(blob.subarray(0, 32 * FIELD_ELEMENTS)));
const batch = decodeBatchPrefix(brotliDecodePrefix(compressed, 112).output);
let l2Raw: RpcBlockHeader;
if (batch.type === "singular") {
	l2Raw = await getBlock(l2, batch.parentHash, true);
} else {
	// OP Mainnet: L2 genesis 105235063 at 1686068903, 2s blocks
	const first = 105235063n + batch.relTimestamp / 2n;
	l2Raw = await getBlock(l2, numberToHex(first - 1n));
	if (!l2Raw.hash.startsWith(batch.parentCheck)) throw new Error("parent check mismatch");
}
const l2Header = encodeBlockHeader(l2Raw);
const account = await l2.getProof({
	address: deployment.L2ReverseRegistrar,
	storageKeys: [],
	blockNumber: BigInt(l2Raw.number),
});

const out = {
	chain,
	systemConfig,
	inbox,
	batcher,
	l1Block: Number(block.number),
	l1Hash: block.hash,
	tx: tx.hash,
	txIndex,
	l1Header,
	txProof,
	blobIndex: 0,
	versionedHash,
	commitment,
	fieldElements: bytesToHex(blob.subarray(0, 32 * FIELD_ELEMENTS)),
	blobProof,
	l2Block: Number(BigInt(l2Raw.number)),
	l2Hash: l2Raw.hash,
	l2Header,
	l2StateRoot: l2Raw.stateRoot,
	registrar: deployment.L2ReverseRegistrar,
	accountProof: account.accountProof,
	storageHash: account.storageHash,
};
const file = `${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/${chain}-blob.json`;
await Bun.write(file, `${JSON.stringify(out, null, "\t")}\n`);
console.log(`wrote ${file}`);
