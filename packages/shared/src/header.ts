// Block header RLP (its keccak is the block hash), from an eth_getBlockBy* result.

import { type Hex, keccak256, numberToHex, toRlp } from "viem";

export type RpcBlockHeader = {
	hash: Hex;
	parentHash: Hex;
	sha3Uncles: Hex;
	miner: Hex;
	stateRoot: Hex;
	transactionsRoot: Hex;
	receiptsRoot: Hex;
	logsBloom: Hex;
	difficulty: Hex;
	number: Hex;
	gasLimit: Hex;
	gasUsed: Hex;
	timestamp: Hex;
	extraData: Hex;
	mixHash: Hex;
	nonce: Hex;
	baseFeePerGas?: Hex; // London
	withdrawalsRoot?: Hex; // Shanghai
	blobGasUsed?: Hex; // Cancun
	excessBlobGas?: Hex;
	parentBeaconBlockRoot?: Hex;
	requestsHash?: Hex; // Prague
};

const quantity = (x: Hex) => (BigInt(x) ? numberToHex(BigInt(x)) : "0x");
const OPTIONAL = [
	["baseFeePerGas", true],
	["withdrawalsRoot", false],
	["blobGasUsed", true],
	["excessBlobGas", true],
	["parentBeaconBlockRoot", false],
	["requestsHash", false],
] as const;

export function encodeBlockHeader(b: RpcBlockHeader): Hex {
	const fields: Hex[] = [
		b.parentHash,
		b.sha3Uncles,
		b.miner,
		b.stateRoot,
		b.transactionsRoot,
		b.receiptsRoot,
		b.logsBloom,
		quantity(b.difficulty),
		quantity(b.number),
		quantity(b.gasLimit),
		quantity(b.gasUsed),
		quantity(b.timestamp),
		b.extraData,
		b.mixHash,
		b.nonce,
	];
	for (const [key, isQuantity] of OPTIONAL) {
		const v = b[key];
		if (v === undefined) break; // fields are added in fork order
		fields.push(isQuantity ? quantity(v) : v);
	}
	const rlp = toRlp(fields.map((x) => (x.length % 2 ? `0x0${x.slice(2)}` : x)) as Hex[]);
	if (keccak256(rlp) !== b.hash) throw new Error(`header of block ${BigInt(b.number)} doesn't hash to ${b.hash}`);
	return rlp;
}
