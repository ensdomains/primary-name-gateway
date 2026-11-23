// Partial brotli decoder (RFC 7932): decodes the start of a stream and stops once it has enough.
//
// A reference for a Solidity port that reads an OP Stack batch prefix out of a compressed channel.
// It's shaped for that port: bits are read one at a time, prefix codes are decoded canonically
// (no lookup tables), and the static dictionary is not supported. A dictionary reference throws
// BrotliUnsupported: a verifier can refuse such a stream (liveness), never misread it (safety).
// The dictionary has binary words too (eg. ffffffff00000000), so this can happen to binary data.
//
// Constants are from https://github.com/google/brotli (c/common/context.c, c/common/constants.c,
// c/dec/prefix.c, c/dec/decode.c).

export class BrotliError extends Error {}
export class BrotliUnsupported extends BrotliError {}

// what a decode cost, for sizing the Solidity port
export type BrotliStats = {
	bits: number; // bits read
	metaBlocks: number;
	prefixCodes: number; // prefix codes read (simple + complex)
	complexCodes: number;
	codeLengthSymbols: number; // symbols decoded while reading complex code lengths
	contextMapSymbols: number;
	blockTypes: [number, number, number]; // literal, command, distance
	literalTrees: number;
	distanceTrees: number;
	headerBits: number; // bits read before the first command of the first compressed meta-block
	commands: number;
	literals: number;
	copies: number;
	treesUsed: number; // distinct literal trees used by the decoded output
};

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const BLOCK_LENGTH_BASE = [
	1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433,
	16625,
];
const BLOCK_LENGTH_EXTRA = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24];
const INSERT_EXTRA = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24];
const COPY_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24];
const INSERT_BASE = prefixSums(0, INSERT_EXTRA);
const COPY_BASE = prefixSums(2, COPY_EXTRA);
// per 64-symbol command range: insert code base | copy code base >> 3 (prefix.c kCellPos)
const CELL_POS = [0, 1, 0, 1, 8, 9, 2, 16, 10, 17, 18];

function prefixSums(start: number, extra: number[]): number[] {
	const v = [start];
	for (let i = 0; i < extra.length - 1; i++) v.push(v[i] + (1 << extra[i]));
	return v;
}

// context lookup (context.c): context = P1[p1] | P2[p2]; LSB6 and MSB6 are p1 & 63 and p1 >> 2
const UTF8_P1 = hexTable(
	"0000000000000000000404000004000000000000000000000000000000000000080c100c0c140c10181c0c0c200c240c2c2c2c2c2c2c2c2c2c2c202018281c0c0c3034343430343434303434343434303434343434303434343434180c1c0c0c0c383c3c3c383c3c3c383c3c3c3c3c383c3c3c3c3c383c3c3c3c3c180c1c0c000001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000102030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203020302030203",
);
const UTF8_P2 = hexTable(
	"00000000000000000000000000000000000000000000000000000000000000000001010101010101010101010101010102020202020202020202010101010101010202020202020202020202020202020202020202020202020202010101010101030303030303030303030303030303030303030303030303030301010101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000202020202020202020202020202020202020202020202020202020202020202",
);
const SIGNED_P1 = hexTable(
	"00080808080808080808080808080808101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818182020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202028282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282830303030303030303030303030303038",
);
const SIGNED_P2 = hexTable(
	"00010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040405050505050505050505050505050505050505050505050505050505050505050505050505050505050505050505050506060606060606060606060606060607",
);

function hexTable(hex: string): Uint8Array {
	return Uint8Array.from({ length: hex.length >> 1 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function literalContext(mode: number, p1: number, p2: number): number {
	switch (mode) {
		case 0:
			return p1 & 63;
		case 1:
			return p1 >> 2;
		case 2:
			return UTF8_P1[p1] | UTF8_P2[p2];
		default:
			return SIGNED_P1[p1] | SIGNED_P2[p2];
	}
}

class BitReader {
	pos = 0; // in bits
	constructor(readonly buf: Uint8Array) {}
	bit(): number {
		const i = this.pos >> 3;
		if (i >= this.buf.length) throw new BrotliError("truncated");
		return (this.buf[i] >> (this.pos++ & 7)) & 1;
	}
	bits(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) v += this.bit() * 2 ** i;
		return v;
	}
	// skip to a byte boundary; the padding must be zero
	align() {
		while (this.pos & 7) if (this.bit()) throw new BrotliError("nonzero padding");
	}
}

// canonical prefix code: symbols ordered by (length, value); a single symbol has a 0-bit code
type PrefixCode = { counts: number[]; symbols: number[] };

function canonical(lengths: number[]): PrefixCode {
	const counts = new Array(16).fill(0);
	for (const n of lengths) counts[n]++;
	counts[0] = 0;
	const symbols: number[] = [];
	for (let n = 1; n < 16; n++) for (let s = 0; s < lengths.length; s++) if (lengths[s] === n) symbols.push(s);
	return { counts, symbols };
}

class Decoder {
	readonly r: BitReader;
	readonly out: number[] = [];
	readonly stats: BrotliStats = {
		bits: 0,
		metaBlocks: 0,
		prefixCodes: 0,
		complexCodes: 0,
		codeLengthSymbols: 0,
		contextMapSymbols: 0,
		blockTypes: [0, 0, 0],
		literalTrees: 0,
		distanceTrees: 0,
		headerBits: 0,
		commands: 0,
		literals: 0,
		copies: 0,
		treesUsed: 0,
	};
	readonly treesUsed = new Set<number>();
	readonly dist = [4, 11, 15, 16]; // last, second-to-last, ...

	constructor(data: Uint8Array) {
		this.r = new BitReader(data);
	}

	decodeSymbol(code: PrefixCode): number {
		if (code.symbols.length === 1) return code.symbols[0];
		let c = 0;
		let first = 0;
		let index = 0;
		for (let n = 1; n < 16; n++) {
			c |= this.r.bit();
			const count = code.counts[n];
			if (c - first < count) return code.symbols[index + c - first];
			index += count;
			first = (first + count) << 1;
			c <<= 1;
		}
		throw new BrotliError("invalid prefix code");
	}

	varLenUint8(): number {
		if (!this.r.bit()) return 0;
		const n = this.r.bits(3);
		return n ? (1 << n) + this.r.bits(n) : 1;
	}

	readPrefixCode(alphabetSize: number): PrefixCode {
		const { r, stats } = this;
		stats.prefixCodes++;
		const hskip = r.bits(2);
		if (hskip === 1) {
			// simple: 1-4 symbols with fixed lengths
			const nsym = r.bits(2) + 1;
			const width = (alphabetSize - 1).toString(2).length;
			const syms: number[] = [];
			for (let i = 0; i < nsym; i++) {
				const s = r.bits(width);
				if (s >= alphabetSize || syms.includes(s)) throw new BrotliError("invalid simple code");
				syms.push(s);
			}
			const shape = nsym === 4 && r.bit() ? [1, 2, 3, 3] : [[0], [1, 1], [1, 2, 2], [2, 2, 2, 2]][nsym - 1];
			const lengths = new Array(alphabetSize).fill(0);
			syms.forEach((s, i) => {
				lengths[s] = shape[i];
			});
			return nsym === 1 ? { counts: new Array(16).fill(0), symbols: syms } : canonical(lengths);
		}
		// complex: code lengths coded with a code-length code
		stats.complexCodes++;
		const clLengths = new Array(18).fill(0);
		let space = 32;
		let numCodes = 0;
		for (let i = hskip; i < 18 && space > 0; i++) {
			// fixed code (decode.c kCodeLengthPrefixValue), read a bit at a time
			let v: number;
			const p = r.bit() | (r.bit() << 1);
			if (p !== 3) v = [0, 4, 3][p];
			else if (!r.bit()) v = 2;
			else v = r.bit() ? 5 : 1;
			clLengths[CODE_LENGTH_ORDER[i]] = v;
			if (v) {
				space -= 32 >> v;
				numCodes++;
			}
		}
		if (numCodes !== 1 && space !== 0) throw new BrotliError("invalid code length code");
		const clCode =
			numCodes === 1
				? { counts: new Array(16).fill(0), symbols: [clLengths.findIndex((x) => x)] }
				: canonical(clLengths);
		const lengths = new Array(alphabetSize).fill(0);
		let sym = 0;
		let prev = 8; // last nonzero length
		let repeat = 0;
		let repeatLen = 0;
		space = 32768;
		while (sym < alphabetSize && space > 0) {
			const c = this.decodeSymbol(clCode);
			stats.codeLengthSymbols++;
			if (c < 16) {
				repeat = 0;
				lengths[sym++] = c;
				if (c) {
					prev = c;
					space -= 32768 >> c;
				}
				continue;
			}
			const extra = c === 16 ? 2 : 3;
			const len = c === 16 ? prev : 0;
			if (repeatLen !== len) {
				repeat = 0;
				repeatLen = len;
			}
			const old = repeat;
			if (repeat > 0) repeat = (repeat - 2) << extra;
			repeat += r.bits(extra) + 3;
			const delta = repeat - old;
			if (sym + delta > alphabetSize) throw new BrotliError("code length repeat overflow");
			for (let i = 0; i < delta; i++) lengths[sym++] = repeatLen;
			if (repeatLen) space -= delta * (32768 >> repeatLen);
		}
		if (space !== 0) throw new BrotliError("incomplete prefix code");
		return canonical(lengths);
	}

	readContextMap(size: number, trees: number): number[] {
		const { r, stats } = this;
		const map = new Array(size).fill(0);
		if (trees < 2) return map;
		const rleMax = r.bit() ? r.bits(4) + 1 : 0;
		const code = this.readPrefixCode(trees + rleMax);
		for (let i = 0; i < size; ) {
			const s = this.decodeSymbol(code);
			stats.contextMapSymbols++;
			if (s === 0) {
				i++;
			} else if (s <= rleMax) {
				const run = (1 << s) + r.bits(s);
				if (i + run > size) throw new BrotliError("context map overflow");
				i += run; // zeros
			} else {
				map[i++] = s - rleMax;
			}
		}
		if (r.bit()) {
			// inverse move-to-front
			const mtf = Array.from({ length: 256 }, (_, i) => i);
			for (let i = 0; i < size; i++) {
				const k = map[i];
				const v = mtf[k];
				map[i] = v;
				if (k) {
					mtf.splice(k, 1);
					mtf.unshift(v);
				}
			}
		}
		return map;
	}

	readBlockLength(code: PrefixCode): number {
		const s = this.decodeSymbol(code);
		return BLOCK_LENGTH_BASE[s] + this.r.bits(BLOCK_LENGTH_EXTRA[s]);
	}

	// decode until at least `need` bytes are out (or the stream ends)
	run(need: number) {
		const { r, out, stats } = this;
		// window bits
		let wbits = 16;
		if (r.bit()) {
			const n = r.bits(3);
			if (n) wbits = 17 + n;
			else {
				const m = r.bits(3);
				if (m === 1) throw new BrotliUnsupported("large window");
				wbits = m ? 8 + m : 17;
			}
		}
		const maxBackward = (1 << wbits) - 16;
		while (out.length < need) {
			stats.metaBlocks++;
			const isLast = r.bit();
			if (isLast && r.bit()) break; // last and empty
			const nibbles = r.bits(2);
			if (nibbles === 3) {
				// metadata: skipped
				if (isLast) throw new BrotliUnsupported("last metadata block");
				if (r.bit()) throw new BrotliError("reserved bit");
				const skipBytes = r.bits(2);
				let skip = 0;
				for (let i = 0; i < skipBytes; i++) {
					const b = r.bits(8);
					if (i + 1 === skipBytes && skipBytes > 1 && !b) throw new BrotliError("non-minimal skip length");
					skip += b * 2 ** (8 * i);
				}
				r.align();
				r.pos += 8 * (skipBytes ? skip + 1 : 0);
				continue;
			}
			let mlen = 0;
			for (let i = 0; i < nibbles + 4; i++) {
				const nib = r.bits(4);
				if (i + 1 === nibbles + 4 && i >= 4 && !nib) throw new BrotliError("non-minimal length");
				mlen += nib * 2 ** (4 * i);
			}
			mlen += 1;
			if (!isLast && r.bit()) {
				// uncompressed
				r.align();
				for (let i = 0; i < mlen; i++) out.push(r.bits(8));
				continue;
			}
			this.compressedMetaBlock(mlen, need, maxBackward);
			if (isLast) break;
		}
		stats.bits = r.pos;
		stats.treesUsed = this.treesUsed.size;
	}

	compressedMetaBlock(mlen: number, need: number, maxBackward: number) {
		const { r, out, stats, dist } = this;
		// block types and counts per category: literal, command, distance
		const nbl = [0, 0, 0];
		const typeCodes: (PrefixCode | undefined)[] = [];
		const lenCodes: (PrefixCode | undefined)[] = [];
		const blockLen = [0, 0, 0];
		for (let i = 0; i < 3; i++) {
			nbl[i] = this.varLenUint8() + 1;
			if (nbl[i] >= 2) {
				typeCodes[i] = this.readPrefixCode(nbl[i] + 2);
				lenCodes[i] = this.readPrefixCode(26);
				blockLen[i] = this.readBlockLength(lenCodes[i]!);
			} else {
				blockLen[i] = 2 ** 30;
			}
		}
		const type = [0, 0, 0];
		const prevType = [1, 1, 1]; // second-to-last
		const npostfix = r.bits(2);
		const ndirect = r.bits(4) << npostfix;
		const modes = Array.from({ length: nbl[0] }, () => r.bits(2));
		const ntreesL = this.varLenUint8() + 1;
		const cmapL = this.readContextMap(64 * nbl[0], ntreesL);
		const ntreesD = this.varLenUint8() + 1;
		const cmapD = this.readContextMap(4 * nbl[2], ntreesD);
		const literalCodes = Array.from({ length: ntreesL }, () => this.readPrefixCode(256));
		const commandCodes = Array.from({ length: nbl[1] }, () => this.readPrefixCode(704));
		const distanceCodes = Array.from({ length: ntreesD }, () => this.readPrefixCode(16 + ndirect + (48 << npostfix)));
		if (!stats.headerBits) {
			stats.headerBits = r.pos;
			stats.blockTypes = [nbl[0], nbl[1], nbl[2]];
			stats.literalTrees = ntreesL;
			stats.distanceTrees = ntreesD;
		}
		const switchBlock = (i: number) => {
			let t = this.decodeSymbol(typeCodes[i]!);
			t = t === 0 ? prevType[i] : t === 1 ? type[i] + 1 : t - 2;
			if (t >= nbl[i]) t -= nbl[i];
			prevType[i] = type[i];
			type[i] = t;
			blockLen[i] = this.readBlockLength(lenCodes[i]!);
		};

		let remaining = mlen;
		while (remaining > 0 && out.length < need) {
			if (!blockLen[1]) switchBlock(1);
			blockLen[1]--;
			const cmd = this.decodeSymbol(commandCodes[type[1]]);
			stats.commands++;
			const cell = CELL_POS[cmd >> 6];
			const insertCode = (cell & 0x18) + ((cmd >> 3) & 7);
			const copyCode = ((cell << 3) & 0x18) + (cmd & 7);
			const insertLen = INSERT_BASE[insertCode] + r.bits(INSERT_EXTRA[insertCode]);
			const copyLen = COPY_BASE[copyCode] + r.bits(COPY_EXTRA[copyCode]);
			if (insertLen > remaining) throw new BrotliError("insert past meta-block");
			for (let i = 0; i < insertLen; i++) {
				if (!blockLen[0]) switchBlock(0);
				blockLen[0]--;
				const n = out.length;
				const ctx = literalContext(modes[type[0]], n ? out[n - 1] : 0, n > 1 ? out[n - 2] : 0);
				const tree = cmapL[64 * type[0] + ctx];
				this.treesUsed.add(tree);
				out.push(this.decodeSymbol(literalCodes[tree]));
				stats.literals++;
				if (out.length >= need) return; // enough: the rest of the command isn't needed
			}
			remaining -= insertLen;
			if (!remaining) break; // the copy is ignored at the end of a meta-block
			let distance: number;
			let code = 0;
			if (cmd >> 6 < 2) {
				distance = dist[0]; // implicit distance code 0
			} else {
				if (!blockLen[2]) switchBlock(2);
				blockLen[2]--;
				const ctx = copyLen > 4 ? 3 : copyLen - 2;
				code = this.decodeSymbol(distanceCodes[cmapD[4 * type[2] + ctx]]);
				distance = this.distance(code, npostfix, ndirect);
			}
			const maxDistance = Math.min(out.length, maxBackward);
			if (distance > maxDistance) {
				throw new BrotliUnsupported(
					`static dictionary reference at ${out.length}: length ${copyLen}, address ${distance - maxDistance - 1}`,
				);
			}
			if (code) {
				// every explicit distance but code 0 enters the ring
				dist.pop();
				dist.unshift(distance);
			}
			if (copyLen > remaining) throw new BrotliError("copy past meta-block");
			for (let i = 0; i < copyLen; i++) out.push(out[out.length - distance]);
			remaining -= copyLen;
			stats.copies++;
		}
	}

	distance(code: number, npostfix: number, ndirect: number): number {
		if (code < 16) {
			// recent distances: 0-3 index the ring, 4-15 are last or second-to-last +- 1..3
			const d = code < 4 ? this.dist[code] : this.dist[code < 10 ? 0 : 1] + [-1, 1, -2, 2, -3, 3][(code - 4) % 6];
			if (d <= 0) throw new BrotliError("invalid distance");
			return d;
		}
		if (code < 16 + ndirect) return code - 15;
		const x = code - ndirect - 16;
		const nbits = 1 + (x >> (npostfix + 1));
		const offset = ((2 + ((x >> npostfix) & 1)) << nbits) - 4;
		return (offset + this.r.bits(nbits)) * 2 ** npostfix + (x & ((1 << npostfix) - 1)) + ndirect + 1;
	}
}

// the first `need` bytes of a brotli stream (fewer if it ends first), and what it took to get them
export function brotliDecodePrefix(data: Uint8Array, need: number): { output: Uint8Array; stats: BrotliStats } {
	const d = new Decoder(data);
	d.run(need);
	return { output: Uint8Array.from(d.out.slice(0, need)), stats: d.stats };
}
