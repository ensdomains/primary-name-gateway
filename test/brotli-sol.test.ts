// BrotliPrefix.sol must decode exactly what the TypeScript reference (brotli.ts) decodes, and
// refuse what it refuses: BrotliUnsupported for the static dictionary, BrotliInvalid otherwise.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, constants } from "node:zlib";
import { Foundry } from "@adraffy/blocksmith";
import { BrotliUnsupported, brotliDecodePrefix } from "@primary-name-gateway/shared";
import { bytesToHex, type Hex } from "viem";

let foundry: Foundry;
let harness: Awaited<ReturnType<Foundry["deploy"]>>;

beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
	harness = await foundry.deploy({ file: "BrotliHarness" });
}, 60_000);

afterAll(() => foundry?.shutdown());

type Result = { output: Hex; gas?: number } | { error: "unsupported" | "invalid" };

function reference(stream: Uint8Array, need: number): Result {
	try {
		return { output: bytesToHex(brotliDecodePrefix(stream, need).output) };
	} catch (err) {
		return { error: err instanceof BrotliUnsupported ? "unsupported" : "invalid" };
	}
}

async function solidity(stream: Uint8Array, need: number): Promise<Result> {
	try {
		const [output, gas] = await harness.decode(stream, need);
		return { output, gas: Number(gas) };
	} catch (err) {
		const name = (err as { revert?: { name?: string } }).revert?.name;
		if (name === "BrotliUnsupported") return { error: "unsupported" };
		if (name === "BrotliInvalid") return { error: "invalid" };
		throw err;
	}
}

async function same(stream: Uint8Array, need: number) {
	const want = reference(stream, need);
	const got = await solidity(stream, need);
	if ("output" in want) expect(got).toMatchObject({ output: want.output });
	else expect(got).toEqual(want);
	return got;
}

const fixture = async (name: string) =>
	new Uint8Array(
		await Bun.file(`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/${name}-frame0.bin`).arrayBuffer(),
	);

describe("BrotliPrefix.sol", () => {
	test("batcher frames", async () => {
		for (const [name, need] of [
			["op", 64],
			["base", 112],
		] as const) {
			const stream = (await fixture(name)).subarray(1);
			const got = await same(stream, need);
			console.log(`${name}: ${need} bytes, ${(got as { gas: number }).gas.toLocaleString()} gas`);
		}
	}, 60_000);

	function rng(seed: number) {
		return () => {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
	}

	test("compressed inputs (all qualities, windows, modes)", async () => {
		const random = rng(5);
		const bytes = (n: number) => Uint8Array.from({ length: n }, () => (random() * 256) | 0);
		const kinds = [
			(n: number) => bytes(n),
			(n: number) => Uint8Array.from({ length: n }, () => [0, 1, 0xff, 0x80][(random() * 4) | 0]),
			(n: number) => new TextEncoder().encode("the block batch of ethereum name data 0x ".repeat(n).slice(0, n)),
			(n: number) => Uint8Array.from({ length: n }, (_, i) => (i % 37 < 20 ? (random() * 256) | 0 : i & 0xff)),
		];
		const counts = { ok: 0, unsupported: 0 };
		for (let i = 0; i < 120; i++) {
			const input = kinds[i % kinds.length](1 + Math.floor(random() * 3000));
			const stream = brotliCompressSync(input, {
				params: {
					[constants.BROTLI_PARAM_QUALITY]: i % 12,
					[constants.BROTLI_PARAM_LGWIN]: 10 + (i % 15),
					[constants.BROTLI_PARAM_MODE]: i % 3,
				},
			});
			const got = await same(stream, 1 + Math.floor(random() * input.length));
			if ("output" in got) counts.ok++;
			else counts.unsupported++;
		}
		expect(counts.ok).toBeGreaterThan(counts.unsupported);
	}, 300_000);

	test("corrupted and truncated streams fail the same way", async () => {
		const frame = (await fixture("op")).subarray(1);
		const random = rng(13);
		for (let i = 0; i < 150; i++) {
			const s = frame.slice(0, 1200 + Math.floor(random() * 200));
			for (let k = 1 + Math.floor(random() * 3); k > 0; k--) {
				s[Math.floor(random() * 1144)] ^= 1 << Math.floor(random() * 8);
			}
			await same(s, 64);
		}
		for (const n of [0, 1, 100, 1000, 1143]) await same(frame.subarray(0, n), 64);
	}, 300_000);
});
