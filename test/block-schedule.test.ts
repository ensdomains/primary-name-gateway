// L2 block times (shared/chains.ts BlockSchedule) and finding a span batch's parent by timestamp, before
// and after Base's Denim upgrade (2 s to 200 ms blocks, header timestamps still in whole seconds).

import { expect, test } from "bun:test";
import { spanBatchParent } from "@primary-name-gateway/registrar-indexer";
import {
	BASE_MAINNET,
	blocksAtTimestamp,
	brotliDecodePrefix,
	decodeBatchPrefix,
	OP_MAINNET,
	type RpcBlockHeader,
} from "@primary-name-gateway/shared";
import type { Hex } from "viem";

const BASE = BASE_MAINNET.l2Blocks;

test("Base: one block per 2 s before Denim, five per second after (headers seen 2026-11-23)", () => {
	expect(blocksAtTimestamp(BASE, 1686789347)).toEqual([0, 0]); // genesis
	expect(blocksAtTimestamp(BASE, 1686789348)).toBeUndefined(); // between 2 s blocks
	expect(blocksAtTimestamp(BASE, 1793901599)).toEqual([53556126, 53556126]); // the last 2 s block
	expect(blocksAtTimestamp(BASE, 1793901600)).toBeUndefined();
	expect(blocksAtTimestamp(BASE, 1793901601)).toEqual([53556127, 53556131]); // Denim's first second
	expect(blocksAtTimestamp(BASE, 1795470750)).toEqual([61401872, 61401876]);
	expect(blocksAtTimestamp(BASE, 1795470751)).toEqual([61401877, 61401881]);
	expect(blocksAtTimestamp(BASE, 1686789346)).toBeUndefined(); // before genesis
});

test("OP Mainnet: one block per 2 s from Bedrock", () => {
	expect(blocksAtTimestamp(OP_MAINNET.l2Blocks, 1686068903)).toEqual([105235063, 105235063]);
	expect(blocksAtTimestamp(OP_MAINNET.l2Blocks, 1686068904)).toBeUndefined();
	expect(blocksAtTimestamp(OP_MAINNET.l2Blocks, 1686068905)).toEqual([105235064, 105235064]);
});

// headers by number with made-up hashes, except `known`; records what was asked
function headers(known: Record<number, Hex>) {
	const asked: number[] = [];
	const get = async (n: number) => {
		asked.push(n);
		const hash = known[n] ?? (`0x${n.toString(16).padStart(64, "f")}` as Hex);
		return { number: `0x${n.toString(16)}`, hash } as RpcBlockHeader;
	};
	return { get, asked };
}

test("OP Mainnet span batch (fixture): its timestamp names exactly the parent's child", async () => {
	const dir = `${import.meta.dir}/../packages/contracts/test/fixtures/op-batch`;
	const f = await Bun.file(`${dir}/op-blob.json`).json();
	const frame = new Uint8Array(await Bun.file(`${dir}/op-frame0.bin`).arrayBuffer());
	const batch = decodeBatchPrefix(brotliDecodePrefix(frame.subarray(1), 112).output);
	if (batch.type !== "span") throw new Error("expected a span batch");
	const { get, asked } = headers({ [f.l2Block]: f.l2Hash });
	const parent = await spanBatchParent(OP_MAINNET.l2Blocks, batch.relTimestamp, batch.parentCheck, get);
	expect(parent.hash).toBe(f.l2Hash);
	expect(asked).toEqual([f.l2Block]);
});

test("Base after Denim: the parent check picks among the blocks sharing a second", async () => {
	const rel = BigInt(1793901601 - BASE[0].timestamp); // blocks 53,556,127 to 53,556,131
	const hash = `0x${"ab".repeat(32)}` as Hex;
	const { get, asked } = headers({ 53556128: hash });
	const parent = await spanBatchParent(BASE, rel, hash.slice(0, 42), get);
	expect(BigInt(parent.number)).toBe(53556128n); // the span starts at 53,556,129
	expect(asked).toEqual([53556126, 53556127, 53556128]);
	// no candidate's parent matches
	await expect(spanBatchParent(BASE, rel, `0x${"cd".repeat(20)}`, headers({}).get)).rejects.toThrow("has the parent");
	// a second no block has
	await expect(spanBatchParent(BASE, 1n, hash.slice(0, 42), get)).rejects.toThrow("no L2 block at timestamp");
});
