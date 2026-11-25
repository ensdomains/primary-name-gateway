// Fixture for the EigenDA inbox tests (Celo), from a real batcher transaction: its certificate, the
// blob's first evaluations with their proof (fetched from the EigenDA relay, proven with
// registrar-indexer's eigenda.ts), the L1 header and the transaction's trie proof, the batch's parent
// L2 header, and the registrar's account proof there.
//
//   bun scripts/eigen-fixture.ts <L1 block>   (the relay keeps blobs for a while: a recent block)

import { EigenDAKZG, fetchEigenDABlob } from "@primary-name-gateway/registrar-indexer";
import {
	brotliDecodePrefix,
	channelStart,
	createClient,
	DEPLOYMENTS,
	decodeBatchPrefix,
	decodeEigenDACalldata,
	eigenDABlobKey,
	eigenDAElementsFor,
	eigenDAPayloadPrefix,
	encodeBlockHeader,
	MAINNET,
	type RpcBlockHeader,
	rawTransaction,
	transactionsTrieProof,
} from "@primary-name-gateway/shared";
import { hexToBytes, numberToHex, parseAbi, type RpcTransaction } from "viem";

const SYSTEM_CONFIG = "0x89E31965D844a309231B1f17759Ccaf1b7c09861";
const INBOX = "0xff00000000000000000000000000000000042220";
const RELAY_REGISTRY = "0xD160e6C1543f562fc2B0A5bf090aED32640Ec55B"; // EigenDADirectory RELAY_REGISTRY

const blockArg = process.argv[2];
if (!blockArg) throw new Error("usage: eigen-fixture.ts <L1 block>");
const l1 = createClient(MAINNET);
const batcherHash = await l1.readContract({
	address: SYSTEM_CONFIG,
	abi: parseAbi(["function batcherHash() view returns (bytes32)"]),
	functionName: "batcherHash",
});
const batcher = `0x${batcherHash.slice(-40)}`;
const getBlock = (client: typeof l1, tag: string, byHash = false) =>
	client.request({
		method: byHash ? "eth_getBlockByHash" : "eth_getBlockByNumber",
		params: [tag, true],
	} as never) as Promise<RpcBlockHeader & { transactions: RpcTransaction[] }>;
const l1Raw = await getBlock(l1, numberToHex(BigInt(blockArg)));
const txIndex = l1Raw.transactions.findIndex((t) => t.to?.toLowerCase() === INBOX && t.from.toLowerCase() === batcher);
if (txIndex < 0) throw new Error(`no batcher transaction in block ${blockArg}`);
const tx = l1Raw.transactions[txIndex];
const cert = decodeEigenDACalldata(tx.input);
if (!cert) throw new Error("not an EigenDA certificate");

// -- the blob, from the relay the certificate names
const relay = await l1.readContract({
	address: RELAY_REGISTRY,
	abi: parseAbi(["function relayKeyToUrl(uint32) view returns (string)"]),
	functionName: "relayKeyToUrl",
	args: [cert.relayKeys[0]],
});
const blob = await fetchEigenDABlob(relay, eigenDABlobKey(cert));
if (blob.length !== 32 * cert.length)
	throw new Error(`blob: ${blob.length} bytes, certificate says ${cert.length} symbols`);
const kzg = await EigenDAKZG.load(cert.length);
const c = kzg.commit(
	Array.from({ length: cert.length }, (_, i) =>
		BigInt(`0x${Buffer.from(blob.subarray(32 * i, 32 * i + 32)).toString("hex")}`),
	),
);
if (c.x !== cert.commitment.x || c.y !== cert.commitment.y) throw new Error("blob doesn't match the certificate");

// -- as many evaluations as the batch prefix needs
const all = kzg.prove(blob, cert.commitment, 64).evaluations;
const { compressed } = channelStart(eigenDAPayloadPrefix(hexToBytes(all)));
const { output, stats } = brotliDecodePrefix(compressed, 112);
const batch = decodeBatchPrefix(output);
const k = eigenDAElementsFor(24 + Math.ceil(stats.bits / 8));
const { evaluations, proof: blobProof } = kzg.prove(blob, cert.commitment, k);

// -- the L1 header and the transaction's proof
const { root, proof: txProof } = transactionsTrieProof(l1Raw.transactions.map(rawTransaction), txIndex);
if (root !== l1Raw.transactionsRoot) throw new Error("transactions root mismatch");

// -- the batch's parent L2 block, and the registrar's account proof there
if (batch.type !== "singular") throw new Error("expected a singular batch");
const deployment = DEPLOYMENTS.celo;
const l2 = createClient(deployment.l2, "proof");
const l2Raw = await getBlock(l2, batch.parentHash, true);
const account = await l2.getProof({
	address: deployment.L2ReverseRegistrar,
	storageKeys: [],
	blockNumber: BigInt(l2Raw.number),
});

const out = {
	chain: "celo",
	systemConfig: SYSTEM_CONFIG,
	inbox: INBOX,
	batcher,
	l1Block: Number(l1Raw.number),
	l1Hash: l1Raw.hash,
	tx: tx.hash,
	txIndex,
	l1Header: encodeBlockHeader(l1Raw),
	txProof,
	commitment: { x: `0x${cert.commitment.x.toString(16)}`, y: `0x${cert.commitment.y.toString(16)}` },
	blobLength: cert.length,
	evaluations,
	blobProof,
	l2Block: Number(BigInt(l2Raw.number)),
	l2Hash: l2Raw.hash,
	l2Header: encodeBlockHeader(l2Raw),
	l2StateRoot: l2Raw.stateRoot,
	registrar: deployment.L2ReverseRegistrar,
	accountProof: account.accountProof,
	storageHash: account.storageHash,
};
const file = `${import.meta.dir}/../packages/contracts/test/fixtures/eigen/celo.json`;
await Bun.write(file, `${JSON.stringify(out, null, "\t")}\n`);
console.log(`wrote ${file}: ${k} evaluations, L2 block ${out.l2Block}`);
