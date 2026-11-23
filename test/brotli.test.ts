// The partial brotli decoder must agree with node's brotli (google/brotli) wherever it decodes,
// and it must never accept a stream that the reference decoder rejects.

import { describe, expect, test } from "bun:test";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { BrotliError, BrotliUnsupported, brotliDecodePrefix, decodeBatchPrefix } from "@primary-name-gateway/shared";

function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

// what the reference decoder emits for (a prefix of) a stream; throws on a format error
function reference(stream: Uint8Array): Uint8Array {
	return brotliDecompressSync(stream, { finishFlush: constants.BROTLI_OPERATION_FLUSH });
}

const fixture = async (name: string) =>
	new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/op-batch/${name}-frame0.bin`).arrayBuffer());

describe("batcher frames (2026-11-23)", () => {
	test("OP Mainnet: span batch", async () => {
		const frame = await fixture("op");
		expect(frame[0]).toBe(1); // channel version 1: brotli
		const { output, stats } = brotliDecodePrefix(frame.subarray(1), 64);
		expect(output).toEqual(reference(frame.subarray(1)).subarray(0, 64));
		expect(decodeBatchPrefix(output)).toEqual({
			type: "span",
			relTimestamp: 109352688n,
			l1OriginNum: 26476561n,
			parentCheck: "0x85a8d7e1dd67d74bbfc07a24a02a743fbceab4eb",
			l1OriginCheck: "0x0935e28066514d64aa74192e99996f27e1e7e144",
		});
		// only the header and a few commands were read
		expect(Math.ceil(stats.bits / 8)).toBeLessThanOrEqual(1144);
		expect(() => brotliDecodePrefix(frame.subarray(1, 1000), 64)).toThrow(BrotliError);
	});

	test("Base: singular batch", async () => {
		const frame = await fixture("base");
		expect(frame[0]).toBe(1);
		const { output } = brotliDecodePrefix(frame.subarray(1), 128);
		expect(output).toEqual(reference(frame.subarray(1)).subarray(0, 128));
		expect(decodeBatchPrefix(output)).toMatchObject({
			type: "singular",
			parentHash: "0xdecc61d123b54504170265a822b02af4c3b7206c72f7eab261dcb9b71c529711",
			epochNum: 26476553n,
		});
	});
});

type Kind = (random: () => number, n: number) => Uint8Array;
const bytes = (random: () => number, n: number) => Uint8Array.from({ length: n }, () => (random() * 256) | 0);
const KINDS: Record<string, Kind> = {
	random: bytes,
	zeros: (_r, n) => new Uint8Array(n),
	lowEntropy: (r, n) => Uint8Array.from({ length: n }, () => [0, 1, 0xff, 0x80][(r() * 4) | 0]),
	// what batches look like: RLP headers, varints, hashes (some repeated), addresses, small numbers
	batchLike: (r, n) => {
		const pool = Array.from({ length: 8 }, () => bytes(r, 32));
		const out: number[] = [0xb9, (n >> 8) & 0xff, n & 0xff, r() < 0.5 ? 0 : 1];
		while (out.length < n) {
			const x = r();
			if (x < 0.3) out.push(0xa0, ...pool[(r() * pool.length) | 0]);
			else if (x < 0.5) out.push(0x94, ...bytes(r, 20));
			else if (x < 0.8) out.push(...bytes(r, 1 + ((r() * 8) | 0)).map((b) => b & 0x7f));
			else out.push(0x80 + ((r() * 40) | 0), ...new Uint8Array((r() * 12) | 0));
		}
		return Uint8Array.from(out.slice(0, n));
	},
	// text, and binary with runs, can use the static dictionary: refused, never misread
	text: (r, n) => {
		const words = ["the", "transaction", "block", "batch", "of", "and", "ethereum", "name", " ", "\n", "0x", "data"];
		let s = "";
		while (s.length < n) s += `${words[(r() * words.length) | 0]} `;
		return new TextEncoder().encode(s.slice(0, n));
	},
};

// a refused copy must be a plausible static dictionary reference (dictionary.c, RFC 7932 section 8):
// a word length with words, and one of the 121 transforms. A wrong distance would rarely pass this.
const DICTIONARY_SIZE_BITS = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5];
function expectDictionaryReference(err: Error) {
	const [, length, address] = /length (\d+), address (\d+)/.exec(err.message)!.map(Number);
	expect(DICTIONARY_SIZE_BITS[length]).toBeGreaterThan(0);
	expect(address >> DICTIONARY_SIZE_BITS[length]).toBeLessThan(121);
}

describe("matches node's brotli", () => {
	const random = rng(7);
	for (const [kind, make] of Object.entries(KINDS)) {
		test(kind, () => {
			const c = { ok: 0, unsupported: 0 };
			for (let i = 0; i < 60; i++) {
				const input = make(random, 1 + Math.floor(random() * 6000));
				const stream = brotliCompressSync(input, {
					params: {
						[constants.BROTLI_PARAM_QUALITY]: i % 12,
						[constants.BROTLI_PARAM_LGWIN]: 10 + (i % 15),
						[constants.BROTLI_PARAM_MODE]: i % 3,
						[constants.BROTLI_PARAM_SIZE_HINT]: input.length,
					},
				});
				const need = 1 + Math.floor(random() * input.length);
				try {
					const { output } = brotliDecodePrefix(stream, need);
					expect(output).toEqual(input.subarray(0, need));
					c.ok++;
				} catch (err) {
					if (!(err instanceof BrotliUnsupported)) throw err;
					expectDictionaryReference(err);
					c.unsupported++;
				}
			}
			if (kind === "random") expect(c.unsupported).toBe(0);
			expect(c.ok).toBeGreaterThan(kind === "text" ? 0 : c.unsupported); // text mostly uses the dictionary
		});
	}

	test("corrupted streams: whatever it decodes, node decodes the same", async () => {
		const frame = (await fixture("op")).subarray(1);
		const random = rng(11);
		let accepted = 0;
		for (let i = 0; i < 400; i++) {
			const s = frame.slice(0, 1400);
			for (let k = 1 + Math.floor(random() * 3); k > 0; k--) {
				s[Math.floor(random() * 1144)] ^= 1 << Math.floor(random() * 8);
			}
			let out: Uint8Array;
			let bits: number;
			try {
				const r = brotliDecodePrefix(s, 64);
				out = r.output;
				bits = r.stats.bits;
			} catch (err) {
				if (!(err instanceof BrotliError)) throw err;
				continue;
			}
			accepted++;
			// the reference decoder reads the same bytes without error and emits the same output
			expect(reference(s.subarray(0, Math.ceil(bits / 8))).subarray(0, out.length)).toEqual(out);
		}
		expect(accepted).toBeGreaterThan(0);
	});
});
