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
		const word = () => {
			const v = bytes();
			if (v.length > 32) throw new Error("batch prefix: number too long");
			return bytesToBigInt(v);
		};
		const parentHash = bytes();
		const epochNum = word();
		const epochHash = bytes();
		const timestamp = word();
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

// Blob data (op-service/eth/blob.go): every 4 field elements carry 127 bytes, 31 from each element
// plus 6 bits of its top byte (the top 2 bits stay zero, so it's below the BLS modulus). The first
// 4 bytes are a version (0) and the 3-byte data length. `fieldElements` holds whole rounds of 4,
// and the result is as much of the data as they carry.
export const BLOB_MAX_DATA = (4 * 31 + 3) * 1024 - 4;

export function blobDataPrefix(fieldElements: Uint8Array): Uint8Array {
	if (fieldElements.length % 128) throw new Error("blob: whole rounds of 4 field elements");
	const raw = new Uint8Array((fieldElements.length / 128) * 127);
	for (let round = 0; round < fieldElements.length / 128; round++) {
		const f = fieldElements.subarray(round * 128, round * 128 + 128);
		const o = raw.subarray(round * 127, round * 127 + 127);
		const top = [0, 1, 2, 3].map((i) => {
			if (f[32 * i] & 0xc0) throw new Error("blob: invalid field element");
			o.set(f.subarray(32 * i + 1, 32 * i + 32), 32 * i);
			return f[32 * i];
		});
		o[31] = (top[0] & 0x3f) | ((top[1] & 0x30) << 2);
		o[63] = (top[1] & 0x0f) | ((top[3] & 0x0f) << 4);
		o[95] = (top[2] & 0x3f) | ((top[3] & 0x30) << 2);
	}
	if (raw[0] !== 0) throw new Error(`blob: version ${raw[0]}`);
	const length = (raw[1] << 16) | (raw[2] << 8) | raw[3];
	if (length > BLOB_MAX_DATA) throw new Error("blob: too long");
	return raw.subarray(4, 4 + Math.min(length, raw.length - 4));
}

// A batcher transaction's data that starts a channel: derivation version 0, then frame 0.
// https://specs.optimism.io/protocol/derivation.html#batcher-transaction-format
export function channelStart(data: Uint8Array): { channelId: Hex; compressed: Uint8Array } {
	if (data.length < 24 || data[0] !== 0) throw new Error("channel: expected derivation version 0");
	const channelId = bytesToHex(data.subarray(1, 17));
	if (data[17] || data[18]) throw new Error("channel: not frame 0");
	const length = ((data[19] << 24) | (data[20] << 16) | (data[21] << 8) | data[22]) >>> 0;
	if (data[23] !== 1) throw new Error(`channel: version ${data[23]} (expected brotli)`);
	// frame data = channel version . brotli stream (as much as `data` has)
	return { channelId, compressed: data.subarray(24, Math.min(data.length, 23 + length)) };
}
