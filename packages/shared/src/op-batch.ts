// The first batch of an OP Stack channel, from the start of its decompressed data: what a batch
// inbox verifier needs to name an L2 block (its parent) and the batch's L1 origin.
// https://specs.optimism.io/protocol/derivation.html#batch-format
// https://specs.optimism.io/protocol/delta/span-batches.html

import { bytesToBigInt, bytesToHex, type Hex } from "viem";

export type BatchPrefix =
	| {
			type: "singular"; // OP Stack before Delta, still used by Base
			parentHash: Hex; // the L2 block before this batch's block
			epochNum: bigint; // L1 origin
			epochHash: Hex;
			timestamp: bigint;
	  }
	| {
			type: "span";
			relTimestamp: bigint; // first block's timestamp - L2 genesis time
			l1OriginNum: bigint; // L1 origin of the last block
			parentCheck: Hex; // first 20 bytes of the parent L2 block hash
			l1OriginCheck: Hex; // first 20 bytes of the last block's L1 origin hash
	  };

// channel data = rlp(batch) ..., batch = type byte . payload
export function decodeBatchPrefix(data: Uint8Array): BatchPrefix {
	let pos = 0;
	const need = (n: number) => {
		if (pos + n > data.length) throw new Error("batch prefix: truncated");
	};
	// RLP header of item: returns the payload length, pos at the payload
	const header = (list: boolean): number => {
		need(1);
		const b = data[pos++];
		const [short, long] = list ? [0xc0, 0xf7] : [0x80, 0xb7];
		if (!list && b < 0x80) {
			pos--;
			return 1;
		}
		if (b < short || b > long + 8) throw new Error("batch prefix: unexpected RLP");
		if (b <= long) return b - short;
		const n = b - long;
		need(n);
		let len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + data[pos++];
		return len;
	};
	const bytes = (): Uint8Array => {
		const n = header(false);
		need(n);
		pos += n;
		return data.subarray(pos - n, pos);
	};
	const uvarint = (): bigint => {
		let v = 0n;
		for (let shift = 0n; ; shift += 7n) {
			need(1);
			const b = data[pos++];
			v |= BigInt(b & 0x7f) << shift;
			if (b < 0x80) return v;
			if (shift > 56n) throw new Error("batch prefix: uvarint overflow");
		}
	};
	header(false); // the batch, as an RLP string
	need(1);
	const type = data[pos++];
	if (type === 0) {
		header(true);
		const parentHash = bytes();
		const epochNum = bytesToBigInt(bytes());
		const epochHash = bytes();
		const timestamp = bytesToBigInt(bytes());
		if (parentHash.length !== 32 || epochHash.length !== 32) throw new Error("batch prefix: bad hash");
		return {
			type: "singular",
			parentHash: bytesToHex(parentHash),
			epochNum,
			epochHash: bytesToHex(epochHash),
			timestamp,
		};
	}
	if (type === 1) {
		const relTimestamp = uvarint();
		const l1OriginNum = uvarint();
		need(40);
		return {
			type: "span",
			relTimestamp,
			l1OriginNum,
			parentCheck: bytesToHex(data.subarray(pos, pos + 20)),
			l1OriginCheck: bytesToHex(data.subarray(pos + 20, pos + 40)),
		};
	}
	throw new Error(`batch prefix: unknown batch type ${type}`);
}
