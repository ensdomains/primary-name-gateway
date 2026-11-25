// EIP-4844 KZG with @noble/curves: blob commitments, and the batched opening OPBlob.verify checks with
// two point evaluation calls: the blob's first n field elements (n a power of two) sit at the n-th roots
// of unity, so they're proven with a commitment to q = (p - I) / (X^n - 1), where I interpolates them,
// and p and q opened at a Fiat-Shamir point. Three 4096-point MSMs, about 0.75s.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { bls12_381 } from "@noble/curves/bls12-381";
import { blobChallenge, encodeBlobProof } from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, sha256 } from "viem";

const N = 4096;
// ethereum/c-kzg-4844 src/trusted_setup.txt (the KZG ceremony output)
const SETUP_URL = "https://raw.githubusercontent.com/ethereum/c-kzg-4844/main/src/trusted_setup.txt";
const SETUP_SHA256 = "0xd39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7";

const Fr = bls12_381.fields.Fr;
const G1 = bls12_381.G1.ProjectivePoint;
type G1Point = InstanceType<typeof G1>;

function bitReverse12(i: number): number {
	let r = 0;
	for (let b = 0; b < 12; b++) r |= ((i >> b) & 1) << (11 - b);
	return r;
}

export class KZG {
	// element i of a blob is the polynomial at domain[i] = ω ** bitReverse12(i), and pairs with the
	// Lagrange point of that root (the setup lists them in natural order)
	private constructor(
		private readonly basis: G1Point[],
		private readonly domain: bigint[],
		private readonly omega: bigint,
	) {}

	// the trusted setup from `path`, downloaded there first if missing (checked against its hash)
	static async load(path = "data/kzg/trusted_setup.txt"): Promise<KZG> {
		if (!existsSync(path)) {
			const res = await fetch(SETUP_URL);
			if (!res.ok) throw new Error(`trusted setup: ${res.status}`);
			mkdirSync(dirname(path), { recursive: true });
			await Bun.write(`${path}.tmp`, await res.text());
			renameSync(`${path}.tmp`, path); // a download cut short leaves no file
		}
		const text = await Bun.file(path).text();
		if (sha256(new TextEncoder().encode(text)) !== SETUP_SHA256) throw new Error(`${path}: unexpected trusted setup`);
		const lines = text.trim().split("\n");
		const lagrange = lines.slice(2, 2 + N).map((h) => G1.fromHex(h.trim()));
		const omega = Fr.pow(7n, (Fr.ORDER - 1n) / BigInt(N));
		const basis: G1Point[] = [];
		const domain: bigint[] = [];
		for (let i = 0; i < N; i++) {
			basis.push(lagrange[bitReverse12(i)]);
			domain.push(Fr.pow(omega, BigInt(bitReverse12(i))));
		}
		return new KZG(basis, domain, omega);
	}

	private evaluations(blob: Uint8Array): bigint[] {
		if (blob.length !== 32 * N) throw new Error("blob: expected 131072 bytes");
		return Array.from({ length: N }, (_, i) => BigInt(bytesToHex(blob.subarray(32 * i, 32 * i + 32))));
	}

	commitment(blob: Uint8Array): Hex {
		const evals = this.evaluations(blob);
		return bytesToHex(G1.msm(this.basis, evals).toRawBytes(true));
	}

	static versionedHash(commitment: Hex): Hex {
		return `0x01${sha256(commitment).slice(4)}`;
	}

	// OPBlob.verify's proof that the blob's first `n` field elements are `blob[0, 32n)`: the commitment to
	// q, p(z), and the openings of p and q at z (encodeBlobProof). `commitment` is the blob's.
	proveFieldElements(blob: Uint8Array, commitment: Hex, n: number): Hex {
		if (n < 1 || n > N || n & (n - 1)) throw new Error("blob: a power of two of field elements");
		const evals = this.evaluations(blob);
		// p's coefficients (natural order evaluations: element i is at ω ** bitReverse12(i))
		const natural = new Array<bigint>(N);
		for (let i = 0; i < N; i++) natural[bitReverse12(i)] = evals[i];
		const coeffs = fft(natural, Fr.inv(this.omega)).map((c) => Fr.mul(c, Fr.inv(BigInt(N))));
		// q = p div (X^n - 1); the remainder is I
		const q = new Array<bigint>(N).fill(0n);
		for (let k = N - n - 1; k >= 0; k--) q[k] = Fr.add(coeffs[k + n], q[k + n] ?? 0n);
		const qNatural = fft(q, this.omega);
		const qEvals = Array.from({ length: N }, (_, i) => qNatural[bitReverse12(i)]);
		const quotient = bytesToHex(G1.msm(this.basis, qEvals).toRawBytes(true));
		const z = blobChallenge(KZG.versionedHash(commitment), commitment, quotient, bytesToHex(blob.subarray(0, 32 * n)));
		const y = horner(coeffs, z);
		return encodeBlobProof({
			quotient,
			y,
			proof: this.openAt(evals, z, y),
			quotientProof: this.openAt(qEvals, z, horner(q, z)),
		});
	}

	// KZG proof that the polynomial with `evals` (element order) is `y` at `z`, outside the domain:
	// a commitment to (p(X) - y) / (X - z)
	private openAt(evals: bigint[], z: bigint, y: bigint): Hex {
		const inv = Fr.invertBatch(this.domain.map((x) => Fr.sub(x, z)));
		const w = evals.map((e, k) => Fr.mul(Fr.sub(e, y), inv[k]));
		return bytesToHex(G1.msm(this.basis, w).toRawBytes(true));
	}
}

// out[j] = sum a[k] root^(jk), for a of power-of-two length (iterative radix 2)
function fft(a: bigint[], root: bigint): bigint[] {
	const n = a.length;
	const bits = Math.log2(n);
	const out = new Array<bigint>(n);
	for (let i = 0; i < n; i++) {
		let r = 0;
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
		out[r] = a[i];
	}
	for (let len = 2; len <= n; len <<= 1) {
		const w = Fr.pow(root, BigInt(n / len));
		const half = len >> 1;
		const ws = [1n];
		for (let k = 1; k < half; k++) ws.push(Fr.mul(ws[k - 1], w));
		for (let s = 0; s < n; s += len) {
			for (let k = 0; k < half; k++) {
				const u = out[s + k];
				const v = Fr.mul(out[s + k + half], ws[k]);
				out[s + k] = Fr.add(u, v);
				out[s + k + half] = Fr.sub(u, v);
			}
		}
	}
	return out;
}

function horner(coeffs: bigint[], x: bigint): bigint {
	let acc = 0n;
	for (let k = coeffs.length - 1; k >= 0; k--) acc = Fr.add(Fr.mul(acc, x), coeffs[k]);
	return acc;
}
