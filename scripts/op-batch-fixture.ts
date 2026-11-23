// Fixture for the batch inbox tests, from a real batcher transaction: the first field elements of its
// blob with a KZG proof for each (EIP-4844 point evaluation at the element's domain point), the L1
// header and the transaction's trie proof, the batch's parent L2 header, and the registrar's account
// proof at that L2 block.
//
//   gh api -H "Accept: application/vnd.github.raw" repos/ethereum/c-kzg-4844/contents/src/trusted_setup.txt > data/kzg/trusted_setup.txt
//   bun scripts/op-batch-fixture.ts <base|op> <L1 block>   (blobs are kept ~18 days)
//
// KZG is computed here with @noble/curves (spec formulas, test fixtures only). It's checked twice:
// the commitment must match the transaction's versioned hash, and the tests check every proof
// with the point evaluation precompile.

import { bls12_381 } from "@noble/curves/bls12-381";
import {
	blobDataPrefix,
	brotliDecodePrefix,
	channelStart,
	createClient,
	DEPLOYMENTS,
	decodeBatchPrefix,
	encodeBlockHeader,
	MAINNET,
	type RpcBlockHeader,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes, keccak256, numberToHex, parseAbi, sha256, toRlp } from "viem";

const BEACON = "https://ethereum-beacon-api.publicnode.com";
const FIELD_ELEMENTS = 64; // enough for Base's batch prefix (OP needs 40)
const N = 4096;
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
const res = await fetch(`${BEACON}/eth/v1/beacon/blobs/${slot}?versioned_hashes=${versionedHash}`);
if (!res.ok) throw new Error(`beacon: ${res.status}`);
const blob = hexToBytes(((await res.json()) as { data: Hex[] }).data[0]);

// -- KZG
const Fr = bls12_381.fields.Fr;
const r = Fr.ORDER;
const G1 = bls12_381.G1.ProjectivePoint;
const setup = (await Bun.file(`${import.meta.dir}/../data/kzg/trusted_setup.txt`).text()).trim().split("\n");
if (setup[0] !== "4096") throw new Error("unexpected trusted setup");
const lagrange = setup.slice(2, 2 + N).map((h) => G1.fromHex(h.trim()));
const brp = (i: number) => Number.parseInt(i.toString(2).padStart(12, "0").split("").reverse().join(""), 2);
const omega = Fr.pow(7n, (r - 1n) / BigInt(N));
const domain = Array.from({ length: N }, (_, i) => Fr.pow(omega, BigInt(brp(i)))); // element i's point
const evals = Array.from({ length: N }, (_, i) => BigInt(bytesToHex(blob.subarray(32 * i, 32 * i + 32))));

// the setup's Lagrange points: natural or bit-reversed order? the commitment decides
const versioned = (c: Uint8Array) => `0x01${sha256(c).slice(4)}` as Hex;
let basis: typeof lagrange | undefined;
let commitment: Uint8Array | undefined;
for (const order of [(i: number) => i, brp]) {
	const points = evals.map((_, i) => lagrange[order(i)]);
	const c = G1.msm(points, evals).toRawBytes(true);
	if (versioned(c) === versionedHash) {
		basis = points;
		commitment = c;
		break;
	}
}
if (!basis || !commitment) throw new Error("commitment doesn't match the versioned hash");

// proof that p(z) = y at a domain point: commit to q(X) = (p(X) - y) / (X - z) (spec:
// compute_quotient_eval_within_domain for the point itself)
function prove(m: number): Hex {
	const z = domain[m];
	const y = evals[m];
	const inv = Fr.invertBatch(domain.map((x, i) => (i === m ? 1n : Fr.sub(x, z))));
	const q = new Array<bigint>(N);
	let qm = 0n;
	const zInv = Fr.inv(z);
	for (let i = 0; i < N; i++) {
		if (i === m) continue;
		const d = Fr.sub(evals[i], y);
		q[i] = Fr.mul(d, inv[i]);
		// (p_i - y) x_i / (z (z - x_i)) = -(p_i - y) x_i / z * 1/(x_i - z)
		qm = Fr.sub(qm, Fr.mul(Fr.mul(Fr.mul(d, domain[i]), zInv), inv[i]));
	}
	q[m] = qm;
	return bytesToHex(G1.msm(basis!, q).toRawBytes(true));
}

const proofs: Hex[] = [];
for (let i = 0; i < FIELD_ELEMENTS; i++) proofs.push(prove(i));
// -- the L1 header and the transaction's proof in the block's transactions trie
const getBlock = (client: typeof l1, tag: Hex, byHash = false) =>
	client.request({
		method: byHash ? "eth_getBlockByHash" : "eth_getBlockByNumber",
		params: [tag, false],
	} as never) as Promise<RpcBlockHeader & { transactions: Hex[] }>;
const l1Raw = await getBlock(l1, numberToHex(block.number));
const l1Header = encodeBlockHeader(l1Raw);
const raws: Hex[] = [];
for (let i = 0; i < l1Raw.transactions.length; i += 25) {
	const batch = l1Raw.transactions.slice(i, i + 25);
	raws.push(
		...(await Promise.all(
			batch.map((h) => l1.request({ method: "eth_getRawTransactionByHash", params: [h] } as never) as Promise<Hex>),
		)),
	);
}
const txIndex = tx.transactionIndex;
const { root: txRoot, proof: txProof } = trieProof(
	raws.map((value, i) => ({ key: nibbles(hexToBytes(toRlp(i ? numberToHex(i) : "0x"))), value })),
	txIndex,
);
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
	commitment: bytesToHex(commitment),
	fieldElements: bytesToHex(blob.subarray(0, 32 * FIELD_ELEMENTS)),
	proofs,
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

// -- a minimal Merkle-Patricia trie over raw keys (the transactions trie; merkle-builder's are storage tries)
function nibbles(b: Uint8Array): number[] {
	return [...b].flatMap((x) => [x >> 4, x & 15]);
}

type Rlp = Hex | Rlp[];

function compact(path: number[], leaf: boolean): Hex {
	// hex-prefix encoding: flag nibble (leaf 2, odd length 1), then the path
	const odd = path.length & 1;
	const flag = ((leaf ? 2 : 0) + odd) << 4;
	const bytes = odd ? [flag | path[0], ...pairs(path.slice(1))] : [flag, ...pairs(path)];
	return bytesToHex(Uint8Array.from(bytes));
}

function pairs(path: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < path.length; i += 2) out.push((path[i] << 4) | path[i + 1]);
	return out;
}

// returns the node and, for `target`, the encoded nodes from this one down
function build(
	items: { key: number[]; value: Hex }[],
	depth: number,
	target: number[] | undefined,
): { node: Rlp; enc: Hex; path: Hex[] } {
	const done = (node: Rlp, below: Hex[] = []) => {
		const enc = toRlp(node as never) as Hex;
		return { node, enc, path: target ? [enc, ...below] : [] };
	};
	if (items.length === 1) return done([compact(items[0].key.slice(depth), true), items[0].value]);
	let n = 0;
	while (items.every((x) => x.key.length > depth + n && x.key[depth + n] === items[0].key[depth + n])) n++;
	const ref = (c: { node: Rlp; enc: Hex }) => ((c.enc.length - 2) / 2 < 32 ? c.node : keccak256(c.enc));
	if (n > 0) {
		const child = build(items, depth + n, target);
		return done([compact(items[0].key.slice(depth, depth + n), false), ref(child)], child.path);
	}
	const branch: Rlp[] = [];
	let below: Hex[] = [];
	for (let i = 0; i < 16; i++) {
		const group = items.filter((x) => x.key[depth] === i);
		if (!group.length) {
			branch.push("0x");
			continue;
		}
		const t = target && target[depth] === i ? target : undefined;
		const child = build(group, depth + 1, t);
		if (t) below = child.path;
		branch.push(ref(child));
	}
	branch.push("0x");
	return done(branch, below);
}

function trieProof(items: { key: number[]; value: Hex }[], index: number): { root: Hex; proof: Hex[] } {
	const { enc, path } = build(items, 0, items[index].key);
	return { root: keccak256(enc), proof: path };
}
