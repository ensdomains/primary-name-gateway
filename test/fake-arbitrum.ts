// An in-memory Arbitrum L2 for the offline e2e: FakeOPRollup's registrar storage and single-account
// state roots, with real block headers (keccak256 of the RLP header is the block hash, as an assertion's
// after state names it). It implements InboxL2Reader, what ArbitrumCommitSource reads.

import type { InboxL2Reader } from "@primary-name-gateway/registrar-indexer";
import { encodeBlockHeader, type RpcBlockHeader } from "@primary-name-gateway/shared";
import { type Hex, keccak256, numberToHex, toRlp, zeroAddress, zeroHash } from "viem";
import { FakeOPRollup } from "./fake-rollup.js";

const EMPTY_TRIE = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";

export class FakeArbitrumL2 extends FakeOPRollup implements InboxL2Reader {
	private readonly headers: RpcBlockHeader[] = [];

	// the header of block n (built once, chained by parent hash)
	headerOf(n: number): RpcBlockHeader {
		for (let i = this.headers.length; i <= n; i++) {
			const b = this.blocks[i];
			if (!b) throw new Error(`no block ${i}`);
			const h: RpcBlockHeader = {
				hash: zeroHash,
				parentHash: i ? this.headers[i - 1].hash : zeroHash,
				sha3Uncles: EMPTY_UNCLES,
				miner: zeroAddress,
				stateRoot: b.witness.stateRoot,
				transactionsRoot: EMPTY_TRIE,
				receiptsRoot: EMPTY_TRIE,
				logsBloom: `0x${"00".repeat(256)}`,
				difficulty: "0x1",
				number: numberToHex(i),
				gasLimit: numberToHex(1n << 50n),
				gasUsed: "0x0",
				timestamp: numberToHex(b.timestamp),
				extraData: zeroHash, // Arbitrum: the send root
				mixHash: zeroHash,
				nonce: "0x0000000000000000",
				baseFeePerGas: numberToHex(100_000_000),
			};
			// the same RLP as encodeBlockHeader (which checks it against `hash`)
			const q = (x: Hex) => (BigInt(x) ? numberToHex(BigInt(x)) : "0x");
			h.hash = keccak256(
				toRlp([
					h.parentHash,
					h.sha3Uncles,
					h.miner,
					h.stateRoot,
					h.transactionsRoot,
					h.receiptsRoot,
					h.logsBloom,
					q(h.difficulty),
					q(h.number),
					q(h.gasLimit),
					q(h.gasUsed),
					q(h.timestamp),
					h.extraData,
					h.mixHash,
					h.nonce,
					q(h.baseFeePerGas!),
				]),
			);
			encodeBlockHeader(h); // checks it
			this.headers.push(h);
		}
		return this.headers[n];
	}

	async header(block: number | Hex): Promise<RpcBlockHeader> {
		if (typeof block === "number") return this.headerOf(block);
		for (let i = 0; i < this.blocks.length; i++) if (this.headerOf(i).hash === block) return this.headerOf(i);
		throw new Error(`no L2 block ${block}`);
	}

	async account(block: number): Promise<{ accountProof: Hex[]; storageHash: Hex }> {
		const { accountProof, storageHash } = this.blocks[block].witness;
		return { accountProof, storageHash };
	}
}
