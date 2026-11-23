// An in-memory Linea L2 that only has a registrar's storage.
//
// - storage is merkle-builder's LineaStorage (independent of the indexer's LineaStorageTrie),
//   written with the registrar's layout and committed once per block like Shomei
// - each mined block has a real world state: a LineaTrie of accounts (the registrar and a few others)
// - getAccountProof() returns linea_getProof's accountProof
//
// It implements LineaL2Reader so a real RegistrarIndexer can index it.

import { LineaStorage } from "@ensdomains/merkle-builder";
import type { LineaL2Reader, RegistrarChange } from "@primary-name-gateway/registrar-indexer";
import {
	applyChange,
	type LineaPathProof,
	LineaTrie,
	lineaAccountKey,
	lineaAccountValueHash,
	type RegistrarLayout,
} from "@primary-name-gateway/shared";
import {
	type Address,
	concat,
	type Hex,
	hexToBytes,
	keccak256,
	numberToHex,
	stringToBytes,
	stringToHex,
	toHex,
} from "viem";

export type FakeLineaBlock = {
	number: number;
	changes: RegistrarChange[];
	storageRoot: Hex;
	stateRoot: Hex;
	accountProof: LineaPathProof;
};

const SNARK_CODE_HASH = keccak256(stringToHex("snark code"));
const KECCAK_CODE_HASH = keccak256(stringToHex("registrar code"));

function account(storageRoot: Hex, nonce = 1, codeSize = 5629): Uint8Array {
	return hexToBytes(
		concat([
			numberToHex(nonce, { size: 32 }),
			numberToHex(0, { size: 32 }),
			storageRoot,
			SNARK_CODE_HASH,
			KECCAK_CODE_HASH,
			numberToHex(codeSize, { size: 32 }),
		]),
	);
}

export class FakeLineaRollup implements LineaL2Reader {
	readonly blocks: FakeLineaBlock[] = [];
	readonly storage = new LineaStorage();
	readonly world = new LineaTrie();
	readonly missingProofs = new Set<number>(); // blocks whose state "Shomei" no longer has
	private queued: Omit<RegistrarChange, "block" | "logIndex">[] = [];

	constructor(
		readonly registrar: Address,
		readonly layout: RegistrarLayout,
		others: Address[] = [],
	) {
		// unrelated accounts around the registrar in the world trie
		for (const [i, addr] of others.entries()) {
			const value = account(toHex(i + 1, { size: 32 }), 0, 0);
			this.world.set(lineaAccountKey(addr), lineaAccountValueHash(value), value);
		}
		this.mine(); // genesis
	}

	get head(): FakeLineaBlock {
		return this.blocks[this.blocks.length - 1];
	}

	// queue a NameForAddrChanged for the next block
	setName(addr: Address, name: string | Uint8Array) {
		this.queued.push({ kind: "name", addr, name: toHex(typeof name === "string" ? stringToBytes(name) : name) });
	}

	// queue an OwnershipTransferred for the next block
	transferOwnership(owner: Address) {
		if (this.layout.ownerSlot === undefined) throw new Error("registrar is not Ownable");
		this.queued.push({ kind: "owner", addr: owner, name: "0x" });
	}

	mine(count = 1): FakeLineaBlock {
		for (let i = 0; i < count; i++) {
			const number = this.blocks.length;
			const changes = this.queued.map((c, logIndex): RegistrarChange => ({ block: number, logIndex, ...c }));
			this.queued = [];
			for (const c of changes) applyChange(this.storage, this.layout, c);
			this.storage.commit(); // one Shomei block
			const storageRoot = this.storage.storageRoot;
			const value = account(storageRoot);
			const hkey = lineaAccountKey(this.registrar);
			this.world.set(hkey, lineaAccountValueHash(value), value);
			this.world.flush();
			this.blocks.push({
				number,
				changes,
				storageRoot,
				stateRoot: this.world.rootHash,
				accountProof: this.world.pathProof(hkey),
			});
		}
		return this.head;
	}

	// -- LineaL2Reader

	async getChanges(fromBlock: number, toBlock: number) {
		toBlock = Math.min(toBlock, this.head.number);
		const changes = this.blocks.slice(fromBlock, toBlock + 1).flatMap((b) => b.changes);
		return { changes, toBlock };
	}

	async getAccountProof(block: number): Promise<LineaPathProof> {
		const b = this.blocks[block];
		if (!b || this.missingProofs.has(block)) throw new Error(`BLOCK_MISSING_IN_CHAIN: ${block}`);
		return b.accountProof;
	}
}
