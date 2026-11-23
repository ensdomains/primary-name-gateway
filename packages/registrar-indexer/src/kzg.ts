// EIP-4844 KZG with @noble/curves: blob commitments, and proofs that a blob's field element is its
// polynomial's value at the element's domain point (what OPBlob.verify checks with the point
// evaluation precompile). About 0.25s per proof (a 4096-point MSM).

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bls12_381 } from "@noble/curves/bls12-381";
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
	) {}

	// the trusted setup from `path`, downloaded there first if missing (checked against its hash)
	static async load(path = "data/kzg/trusted_setup.txt"): Promise<KZG> {
		if (!existsSync(path)) {
			const res = await fetch(SETUP_URL);
			if (!res.ok) throw new Error(`trusted setup: ${res.status}`);
			mkdirSync(dirname(path), { recursive: true });
			await Bun.write(path, await res.text());
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
		return new KZG(basis, domain);
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

	// proof that the blob's polynomial is `blob[i]` at domain[i]: a commitment to
	// q(X) = (p(X) - y) / (X - z), with q at z itself from compute_quotient_eval_within_domain
	proveFieldElement(blob: Uint8Array, i: number): Hex {
		const evals = this.evaluations(blob);
		const z = this.domain[i];
		const y = evals[i];
		const inv = Fr.invertBatch(this.domain.map((x, k) => (k === i ? 1n : Fr.sub(x, z))));
		const zInv = Fr.inv(z);
		const q = new Array<bigint>(N);
		let qz = 0n;
		for (let k = 0; k < N; k++) {
			if (k === i) continue;
			const d = Fr.sub(evals[k], y);
			q[k] = Fr.mul(d, inv[k]);
			qz = Fr.sub(qz, Fr.mul(Fr.mul(Fr.mul(d, this.domain[k]), zInv), inv[k]));
		}
		q[i] = qz;
		return bytesToHex(G1.msm(this.basis, q).toRawBytes(true));
	}
}
