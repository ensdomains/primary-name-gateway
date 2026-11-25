// OPBatchPrefix.sol must read the same batch prefix as op-batch.ts, and refuse what it refuses.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import {
	type BatchPrefix,
	blobDataPrefix,
	brotliDecodePrefix,
	channelStart,
	decodeBatchPrefix,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes, padHex } from "viem";

let foundry: Foundry;
let harness: Awaited<ReturnType<Foundry["deploy"]>>;

beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
	harness = await foundry.deploy({ file: "OPBatchHarness" });
}, 60_000);

afterAll(() => foundry?.shutdown());

// the Solidity struct for a TypeScript prefix
function expected(b: BatchPrefix) {
	return b.type === "singular"
		? [0n, b.parentHash, b.epochNum, b.epochHash, b.timestamp]
		: [
				1n,
				padHex(b.parentCheck, { dir: "right", size: 32 }),
				b.l1OriginNum,
				padHex(b.l1OriginCheck, { dir: "right", size: 32 }),
				b.relTimestamp,
			];
}

async function same(data: Uint8Array) {
	let want: unknown[] | undefined;
	try {
		want = expected(decodeBatchPrefix(data));
	} catch {}
	if (want) {
		expect([...(await harness.batch(data))]).toEqual(want);
	} else {
		await expect(harness.batch(data)).rejects.toThrow(/InvalidBatchPrefix/);
	}
	return !!want;
}

async function prefix(name: string, need: number): Promise<Uint8Array> {
	const frame = new Uint8Array(
		await Bun.file(`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/${name}-frame0.bin`).arrayBuffer(),
	);
	return brotliDecodePrefix(frame.subarray(1), need).output;
}

test("real batches", async () => {
	expect(await same(await prefix("op", 64))).toBeTrue();
	expect(await same(await prefix("base", 112))).toBeTrue();
}, 60_000);

test("truncated and mutated prefixes", async () => {
	let seed = 9;
	const random = () => {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	let ok = 0;
	for (const [name, need] of [
		["op", 64],
		["base", 112],
	] as const) {
		const full = await prefix(name, need);
		for (let n = 0; n <= full.length; n += 3) if (await same(full.subarray(0, n))) ok++;
		for (let i = 0; i < 60; i++) {
			const v = full.slice();
			v[Math.floor(random() * Math.min(v.length, 12))] = Math.floor(random() * 256);
			if (await same(v)) ok++;
		}
	}
	expect(ok).toBeGreaterThan(0);
}, 120_000);

test("synthetic", async () => {
	const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
	// span: short RLP header, uvarints of 1 and 10 bytes
	const span = `01${"ff".repeat(9)}01${"7f"}${"11".repeat(20)}${"22".repeat(20)}`;
	expect(await same(hex(`b8${(span.length / 2).toString(16)}${span}`))).toBeTrue();
	expect(await same(hex(`b8${(span.length / 2).toString(16)}01${"ff".repeat(10)}01`))).toBeFalse(); // uvarint too long
	// singular with single-byte numbers
	const singular = `00f8${"4a"}a0${"33".repeat(32)}05a0${"44".repeat(32)}0780`;
	expect(await same(hex(`b8${(singular.length / 2).toString(16)}${singular}`))).toBeTrue();
	expect(await same(hex("8102"))).toBeFalse(); // unknown batch type
}, 60_000);

type BlobFixture = { versionedHash: Hex; commitment: Hex; fieldElements: Hex; blobProof: Hex };
const blobFixture = async (chain: string): Promise<BlobFixture> =>
	Bun.file(`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/${chain}-blob.json`).json();

test("blob data", async () => {
	for (const chain of ["op", "base"]) {
		const f = await blobFixture(chain);
		const felts = hexToBytes(f.fieldElements);
		expect(await harness.blobData(felts)).toBe(bytesToHex(blobDataPrefix(felts)));
		// fewer rounds: a prefix of the same data
		expect(await harness.blobData(felts.subarray(0, 128))).toBe(bytesToHex(blobDataPrefix(felts.subarray(0, 128))));
		const bad = felts.slice();
		bad[32] |= 0x80; // a top byte with its high bits set
		expect(() => blobDataPrefix(bad)).toThrow();
		await expect(harness.blobData(bad)).rejects.toThrow(/InvalidBlob/);
	}
}, 60_000);

test("blob field elements verify against the versioned hash (batched KZG opening)", async () => {
	for (const chain of ["op", "base"]) {
		const f = await blobFixture(chain);
		const verify = (h = f.versionedHash, felts = f.fieldElements, proof = f.blobProof) =>
			harness.verifyBlob(h, f.commitment, felts, proof);
		const gas = await verify();
		console.log(`${chain}: ${(f.fieldElements.length - 2) / 64} field elements, ${Number(gas).toLocaleString()} gas`);
		const flip = (h: Hex, at: number) => `${h.slice(0, at)}${h[at] === "0" ? "1" : "0"}${h.slice(at + 1)}` as Hex;
		await expect(verify(undefined, undefined, flip(f.blobProof, 2 + 96 + 40))).rejects.toThrow(/InvalidBlobProof/);
		await expect(verify(undefined, flip(f.fieldElements, 2 + 64 * 7 + 10))).rejects.toThrow(/InvalidBlobProof/);
		await expect(verify(flip(f.versionedHash, 20))).rejects.toThrow(/InvalidBlobProof/);
		// half the elements, with the whole set's proof
		await expect(verify(undefined, f.fieldElements.slice(0, 2 + 64 * 32) as Hex)).rejects.toThrow(/InvalidBlobProof/);
	}
}, 120_000);

test("readBatch: blob field elements to the batch prefix", async () => {
	for (const chain of ["op", "base"]) {
		const f = await blobFixture(chain);
		const { channelId, compressed } = channelStart(blobDataPrefix(hexToBytes(f.fieldElements)));
		const want = expected(decodeBatchPrefix(brotliDecodePrefix(compressed, 112).output));
		const [id, b, gas] = await harness.readBatch(f.versionedHash, f.commitment, f.fieldElements, f.blobProof);
		expect(id).toBe(channelId);
		expect([...b]).toEqual(want);
		console.log(`${chain}: readBatch ${Number(gas).toLocaleString()} gas`);
	}
}, 120_000);
