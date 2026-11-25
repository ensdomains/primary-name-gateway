// EigenDA blobs for an alt-DA OP Stack chain (Celo): fetched from an EigenDA relay (gRPC), and the
// proof that its first evaluations are the payload's start (what EigenDABlob.verify checks), with
// EigenDA's trusted setup (the first G1 points of resources/srs/g1.point, downloaded once).
//
// A blob is the coefficients of a polynomial p over BN254's scalar field; the payload is its evaluations
// at the powers of the blob size's root of unity (EigenDA's default, PolynomialFormEval).

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { connect } from "node:http2";
import { dirname } from "node:path";
import { bn254 } from "@noble/curves/bn254";
import {
	type EigenDABlobProof,
	eigenDAChallenge,
	encodeEigenDABlobProof,
	type G1,
	rootOfUnity,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBigInt, hexToBytes } from "viem";

const Fr = bn254.fields.Fr;
const Fp = bn254.fields.Fp;
const G1P = bn254.G1.ProjectivePoint;
type G1Point = InstanceType<typeof G1P>;

const SRS_URL = "https://raw.githubusercontent.com/Layr-Labs/eigenda/master/resources/srs/g1.point";

// a blob from an EigenDA relay: gRPC relay.Relay/GetBlob {1: blob_key} -> {1: blob}
export async function fetchEigenDABlob(relay: string, blobKey: Hex, timeoutMs = 30_000): Promise<Uint8Array> {
	const msg = new Uint8Array([0x0a, 32, ...hexToBytes(blobKey)]);
	const frame = new Uint8Array(5 + msg.length);
	new DataView(frame.buffer).setUint32(1, msg.length);
	frame.set(msg, 5);
	const client = connect(relay.includes("://") ? relay : `https://${relay}:443`);
	try {
		const body = await new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("eigenda relay: timeout")), timeoutMs);
			const req = client.request({
				":method": "POST",
				":path": "/relay.Relay/GetBlob",
				"content-type": "application/grpc",
				te: "trailers",
			});
			const chunks: Buffer[] = [];
			let status: string | undefined;
			req.on("response", (h) => {
				status = h["grpc-status"] as string | undefined;
			});
			req.on("trailers", (h) => {
				status = h["grpc-status"] as string | undefined;
				if (status && status !== "0") reject(new Error(`eigenda relay: grpc ${status} ${h["grpc-message"] ?? ""}`));
			});
			req.on("data", (d: Buffer) => chunks.push(d));
			req.on("error", reject);
			req.on("end", () => {
				clearTimeout(timer);
				resolve(Buffer.concat(chunks));
			});
			req.end(frame);
		});
		// gRPC frame header (5), then field 1 (tag, varint length)
		if (body.length < 7 || body[5] !== 0x0a) throw new Error("eigenda relay: unexpected reply");
		let p = 6;
		let len = 0;
		for (let shift = 0; ; shift += 7) {
			const b = body[p++];
			len += (b & 0x7f) * 2 ** shift;
			if (!(b & 0x80)) break;
		}
		return new Uint8Array(body.subarray(p, p + len));
	} finally {
		client.close();
	}
}

// gnark's compressed G1: big-endian x with the top 2 bits as flags (0b10 smallest y, 0b11 largest, 0b01 infinity)
function decompressG1(b: Uint8Array): G1Point {
	const flag = b[0] >> 6;
	if (flag === 1) return G1P.ZERO;
	const xb = b.slice();
	xb[0] &= 0x3f;
	const x = hexToBigInt(bytesToHex(xb));
	let y = Fp.sqrt(Fp.add(Fp.mul(Fp.mul(x, x), x), 3n));
	if ((flag === 3) !== y > Fp.ORDER - y) y = Fp.neg(y);
	return G1P.fromAffine({ x, y });
}

export class EigenDAKZG {
	private constructor(readonly srs: G1Point[]) {}

	// the first `n` G1 points of EigenDA's setup, from `dir` (downloaded there first if missing). The
	// download is checked by the commitments it reproduces (fetchAndProve compares the certificate's).
	static async load(n: number, dir = "data/eigenda"): Promise<EigenDAKZG> {
		const path = `${dir}/g1-${n}.point`;
		if (!existsSync(path)) {
			const res = await fetch(SRS_URL, { headers: { Range: `bytes=0-${32 * n - 1}` } });
			if (res.status !== 206) throw new Error(`eigenda srs: ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.length !== 32 * n) throw new Error("eigenda srs: short read");
			mkdirSync(dirname(path), { recursive: true });
			await Bun.write(`${path}.tmp`, bytes);
			renameSync(`${path}.tmp`, path);
		}
		const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
		const srs = Array.from({ length: n }, (_, i) => decompressG1(raw.subarray(32 * i, 32 * i + 32)));
		if (!srs[0].equals(G1P.BASE)) throw new Error("eigenda srs: first point isn't the generator");
		return new EigenDAKZG(srs);
	}

	commit(coeffs: bigint[]): G1 {
		if (coeffs.length > this.srs.length) throw new Error("eigenda: polynomial larger than the setup");
		const p = G1P.msm(this.srs.slice(0, coeffs.length), coeffs);
		return p.equals(G1P.ZERO) ? { x: 0n, y: 0n } : p.toAffine();
	}

	// The proof that p's first `k` evaluations (natural order) are `evaluations(blob)[0, k)`: q = p div Z,
	// Z = prod_{i<k} (X - w^i) (the remainder is the interpolation of those evaluations), then p and q
	// opened at the Fiat-Shamir point z.
	prove(blob: Uint8Array, commitment: G1, k: number): { evaluations: Hex; proof: Hex } {
		const n = blob.length / 32;
		const coeffs = Array.from({ length: n }, (_, i) => hexToBigInt(bytesToHex(blob.subarray(32 * i, 32 * i + 32))));
		const w = rootOfUnity(n);
		const evals = fft(coeffs, w);
		const evaluations = bytesToHex(Uint8Array.from(evals.slice(0, k).flatMap((e) => [...hexToBytes(toHex32(e))])));
		// Z's coefficients (monic, degree k)
		let z = [1n];
		for (let i = 0, x = 1n; i < k; i++, x = Fr.mul(x, w)) {
			const next = new Array<bigint>(z.length + 1).fill(0n);
			for (let j = 0; j < z.length; j++) {
				next[j + 1] = Fr.add(next[j + 1], z[j]);
				next[j] = Fr.sub(next[j], Fr.mul(z[j], x));
			}
			z = next;
		}
		// long division by a monic Z
		const rem = coeffs.slice();
		const q = new Array<bigint>(Math.max(n - k, 0)).fill(0n);
		for (let d = n - 1; d >= k; d--) {
			const c = rem[d];
			if (c === 0n) continue;
			q[d - k] = c;
			for (let j = 0; j <= k; j++) rem[d - k + j] = Fr.sub(rem[d - k + j], Fr.mul(c, z[j]));
		}
		const quotient = this.commit(q);
		const at = eigenDAChallenge(commitment, quotient, n, evaluations);
		const y = horner(coeffs, at);
		const p: EigenDABlobProof = {
			quotient,
			y,
			proof: this.commit(divideByLinear(coeffs, at)),
			quotientProof: this.commit(divideByLinear(q, at)),
		};
		return { evaluations, proof: encodeEigenDABlobProof(p) };
	}
}

const toHex32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

function horner(c: bigint[], x: bigint): bigint {
	let acc = 0n;
	for (let i = c.length - 1; i >= 0; i--) acc = Fr.add(Fr.mul(acc, x), c[i]);
	return acc;
}

// (p(X) - p(z)) / (X - z)
function divideByLinear(c: bigint[], z: bigint): bigint[] {
	const out = new Array<bigint>(Math.max(c.length - 1, 0));
	let acc = 0n;
	for (let i = c.length - 1; i >= 1; i--) {
		acc = Fr.add(Fr.mul(acc, z), c[i]);
		out[i - 1] = acc;
	}
	return out;
}

// out[j] = sum a[k] root^(jk), for a of power-of-two length
export function fft(a: bigint[], root: bigint): bigint[] {
	const n = a.length;
	const bits = Math.log2(n);
	const out = new Array<bigint>(n);
	for (let i = 0; i < n; i++) {
		let r = 0;
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
		out[r] = a[i];
	}
	for (let len = 2; len <= n; len <<= 1) {
		const wl = Fr.pow(root, BigInt(n / len));
		const half = len >> 1;
		const ws = [1n];
		for (let k = 1; k < half; k++) ws.push(Fr.mul(ws[k - 1], wl));
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
