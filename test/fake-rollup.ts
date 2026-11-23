// An in-memory OP Stack L2 that only has a registrar's storage.
//
// - names are written with merkle-builder (same layout as L2ReverseRegistrar)
// - each mined block has a real state root: a single-account Merkle-Patricia trie
//   holding the registrar (nonce 0, balance 0, storageRoot, codeHash)
// - output roots and super roots are computed exactly like OP
//
// It implements OPL2Reader so a real RegistrarIndexer can index it.

import { hashOutputRootProof, type OutputRootProof, setPrimaryName } from "@primary-name-gateway/shared";
import type { BlockWitness, L2BlockRef, OPL2Reader, RegistrarChange } from "@primary-name-gateway/registrar-indexer";
import { EthStorage } from "@ensdomains/merkle-builder";
import {
	type Address,
	concat,
	encodeAbiParameters,
	type Hex,
	keccak256,
	numberToHex,
	stringToBytes,
	stringToHex,
	toHex,
	toRlp,
	zeroHash,
} from "viem";

export type FakeBlock = {
	number: number;
	timestamp: number;
	changes: RegistrarChange[];
	storage: EthStorage; // registrar storage after this block (copy-on-write snapshot)
	witness: BlockWitness;
	outputRootProof: OutputRootProof;
	outputRoot: Hex;
};

const CODE_HASH = keccak256(stringToHex("registrar code"));
const MESSAGE_PASSER_ROOT = keccak256(stringToHex("message passer"));

export class FakeOPRollup implements OPL2Reader {
	readonly blocks: FakeBlock[] = [];
	finalized: number | undefined; // finalized head (default: the head)
	private readonly storage = new EthStorage();
	private queued: { addr: Address; name: Hex }[] = [];

	constructor(
		readonly chainId: number,
		readonly registrar: Address,
		readonly genesisTimestamp: number,
		readonly blockTime = 2,
		readonly otherChains: { chainId: number; outputRoot: Hex }[] = [], // extra super root entries
	) {
		this.mine(); // genesis
	}

	get head(): FakeBlock {
		return this.blocks[this.blocks.length - 1];
	}

	// queue a NameForAddrChanged for the next block
	setName(addr: Address, name: string | Uint8Array) {
		this.queued.push({ addr, name: toHex(typeof name === "string" ? stringToBytes(name) : name) });
	}

	mine(count = 1): FakeBlock {
		for (let i = 0; i < count; i++) {
			const number = this.blocks.length;
			const changes = this.queued.map((c, logIndex): RegistrarChange => ({ block: number, logIndex, kind: "name", ...c }));
			this.queued = [];
			for (const c of changes) setPrimaryName(this.storage, c.addr, Buffer.from(c.name.slice(2), "hex"));
			const storageHash = this.storage.storageHash;

			// state trie with one account: the root is a leaf node
			const account = toRlp(["0x", "0x", storageHash, CODE_HASH]);
			const leaf = toRlp([concat(["0x20", keccak256(this.registrar)]), account]);
			const stateRoot = keccak256(leaf);
			const blockHash = keccak256(
				encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(number), stateRoot]),
			);
			const outputRootProof: OutputRootProof = {
				version: zeroHash,
				stateRoot,
				messagePasserStorageRoot: MESSAGE_PASSER_ROOT,
				latestBlockhash: blockHash,
			};
			this.blocks.push({
				number,
				timestamp: this.genesisTimestamp + number * this.blockTime,
				changes,
				storage: this.storage.clone(),
				witness: {
					stateRoot,
					blockHash,
					messagePasserStorageRoot: MESSAGE_PASSER_ROOT,
					accountProof: [leaf],
					storageHash,
				},
				outputRootProof,
				outputRoot: hashOutputRootProof(outputRootProof),
			});
		}
		return this.head;
	}

	// SuperRootV1 = version(1) . timestamp(8) . [chainId(32) . outputRoot(32)]*  (sorted by chain id)
	superRoot(block: FakeBlock, outputRoot = block.outputRoot): Hex {
		const entries = [...this.otherChains, { chainId: this.chainId, outputRoot }].sort((a, b) => a.chainId - b.chainId);
		return concat([
			"0x01",
			numberToHex(block.timestamp, { size: 8 }),
			...entries.flatMap((e) => [numberToHex(e.chainId, { size: 32 }), e.outputRoot]),
		]);
	}

	// -- OPL2Reader

	async finalizedBlock(): Promise<L2BlockRef> {
		const b = this.blocks[this.finalized ?? this.head.number];
		return { number: b.number, timestamp: b.timestamp };
	}

	async blockAtTimestamp(timestamp: bigint): Promise<number> {
		const offset = Number(timestamp) - this.genesisTimestamp;
		const n = offset / this.blockTime;
		if (!Number.isInteger(n) || n < 0 || n >= this.blocks.length) throw new Error(`no block at ${timestamp}`);
		return n;
	}

	async getChanges(fromBlock: number, toBlock: number) {
		toBlock = Math.min(toBlock, this.head.number);
		const changes = this.blocks.slice(fromBlock, toBlock + 1).flatMap((b) => b.changes);
		return { changes, toBlock };
	}

	async getBlockWitness(block: number): Promise<BlockWitness> {
		const b = this.blocks[block];
		if (!b) throw new Error(`no block ${block}`);
		return b.witness;
	}
}
