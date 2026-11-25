// EigenDA (v2) batches of an OP Stack chain with alt-DA (Celo): the L1 batcher transaction carries a
// certificate, the batch data is an EigenDA blob. What a verifier needs from them: the blob's KZG
// commitment (BN254) from the certificate, and the start of the blob's payload.
// https://layr-labs.github.io/eigenda/integration/spec/3-data-structs.html

import {
	bytesToHex,
	concatHex,
	encodeAbiParameters,
	fromRlp,
	type Hex,
	hexToBigInt,
	hexToBytes,
	keccak256,
	numberToHex,
} from "viem";

export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Scale2RootOfUnity[28] in EigenDA's encoding/constants.go: a primitive 2^28-th root of unity
export const BN254_ROOT_OF_UNITY_28 = 19103219067921713944291392827692070036145651957329286315305642004821462161904n;

// the root of unity for a blob of `n` symbols (a power of two): evaluation i is at rootOfUnity(n) ** i
export function rootOfUnity(n: number): bigint {
	if (n < 1 || n > 2 ** 28 || n & (n - 1)) throw new Error(`eigenda: blob length ${n} is not a power of two`);
	let w = BN254_ROOT_OF_UNITY_28;
	for (let s = 2 ** 28; s > n; s >>= 1) w = (w * w) % BN254_R;
	return w;
}

// alt-DA calldata: derivation version 0x01 (alt-DA), commitment type 0x01 (generic), DA layer 0x00
// (EigenDA), certificate version, then the certificate (RLP)
export const EIGENDA_CALLDATA_PREFIX = "0x010100";

export type G1 = { x: bigint; y: bigint };
export type G2 = { x: [bigint, bigint]; y: [bigint, bigint] }; // EIP-197 order: imaginary part first

export type EigenDACert = {
	version: number;
	referenceBlock: number;
	blobVersion: number;
	quorums: Hex;
	commitment: G1;
	lengthCommitment: G2;
	lengthProof: G2;
	length: number; // symbols (32 bytes each)
	paymentHeaderHash: Hex;
	relayKeys: number[];
};

const num = (h: Hex) => (h === "0x" ? 0n : hexToBigInt(h));

// EigenDACertV3 (certificate version 2): [batchHeader, blobInclusionInfo, nonSignerStakesAndSignature,
// signedQuorumNumbers]; blobInclusionInfo = [blobCertificate, blobIndex, inclusionProof],
// blobCertificate = [blobHeader, signature, relayKeys], blobHeader = [version, quorumNumbers,
// commitment, paymentHeaderHash], commitment = [G1, lengthCommitment G2, lengthProof G2, length]
export function decodeEigenDACalldata(input: Hex): EigenDACert | undefined {
	if (!input.toLowerCase().startsWith(EIGENDA_CALLDATA_PREFIX) || input.length < 10) return;
	const version = Number.parseInt(input.slice(8, 10), 16);
	if (version !== 2) return;
	// biome-ignore lint/suspicious/noExplicitAny: RLP lists
	const cert = fromRlp(`0x${input.slice(10)}`) as any;
	const [batchHeader, inclusion] = cert;
	const [blobCert] = inclusion;
	const [header, , relayKeys] = blobCert;
	const [blobVersion, quorums, c, paymentHeaderHash] = header;
	const g2 = (p: Hex[][]): G2 => ({ x: [num(p[0][0]), num(p[0][1])], y: [num(p[1][0]), num(p[1][1])] });
	return {
		version,
		referenceBlock: Number(num(batchHeader[1])),
		blobVersion: Number(num(blobVersion)),
		quorums,
		commitment: { x: num(c[0][0]), y: num(c[0][1]) },
		lengthCommitment: g2(c[1]),
		lengthProof: g2(c[2]),
		length: Number(num(c[3])),
		paymentHeaderHash,
		relayKeys: (relayKeys as Hex[]).map((k) => Number(num(k))),
	};
}

const G1_ABI = {
	type: "tuple",
	components: [
		{ name: "x", type: "uint256" },
		{ name: "y", type: "uint256" },
	],
} as const;
const G2_ABI = {
	type: "tuple",
	components: [
		{ name: "x", type: "uint256[2]" },
		{ name: "y", type: "uint256[2]" },
	],
} as const;

// the relay's key for a blob: keccak(abi.encode(keccak(abi.encode(version, sorted quorums,
// commitments)), paymentHeaderHash)) (core/v2/serialization.go ComputeBlobKey)
export function eigenDABlobKey(c: EigenDACert): Hex {
	const quorums = bytesToHex(Uint8Array.from(hexToBytes(c.quorums)).sort());
	const header = keccak256(
		encodeAbiParameters(
			[
				{ type: "uint16" },
				{ type: "bytes" },
				{
					type: "tuple",
					components: [
						{ name: "commitment", ...G1_ABI },
						{ name: "lengthCommitment", ...G2_ABI },
						{ name: "lengthProof", ...G2_ABI },
						{ name: "dataLength", type: "uint32" },
					],
				},
			],
			[
				c.blobVersion,
				quorums,
				{
					commitment: c.commitment,
					lengthCommitment: c.lengthCommitment,
					lengthProof: c.lengthProof,
					dataLength: c.length,
				},
			],
		),
	);
	return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [header, c.paymentHeaderHash]));
}

// The payload carried by the blob's first evaluations (32 bytes each, natural order): a header element
// (0x00, version 0x00, big-endian uint32 length, zeros), then 31 bytes per element after a 0x00 byte.
// Returns as much of the payload as `evaluations` carries.
export function eigenDAPayloadPrefix(evaluations: Uint8Array): Uint8Array {
	if (evaluations.length < 32 || evaluations.length % 32) throw new Error("eigenda: whole field elements");
	if (evaluations[0] !== 0 || evaluations[1] !== 0) throw new Error("eigenda: payload header");
	for (let i = 6; i < 32; i++) if (evaluations[i]) throw new Error("eigenda: payload header padding");
	const length = new DataView(evaluations.buffer, evaluations.byteOffset).getUint32(2);
	const elements = evaluations.length / 32 - 1;
	const out = new Uint8Array(elements * 31);
	for (let i = 0; i < elements; i++) {
		const e = evaluations.subarray(32 * (i + 1), 32 * (i + 2));
		if (e[0]) throw new Error("eigenda: element padding");
		out.set(e.subarray(1), 31 * i);
	}
	return out.subarray(0, Math.min(length, out.length));
}

// evaluations that carry a payload's first `bytes` bytes (header included)
export function eigenDAElementsFor(bytes: number): number {
	return 1 + Math.ceil(bytes / 31);
}

// EigenDABlob.verify's Fiat-Shamir point: hashes everything the prover chose before it
export function eigenDAChallenge(commitment: G1, quotient: G1, length: number, evaluations: Hex): bigint {
	return (
		BigInt(
			keccak256(
				concatHex([
					numberToHex(commitment.x, { size: 32 }),
					numberToHex(commitment.y, { size: 32 }),
					numberToHex(quotient.x, { size: 32 }),
					numberToHex(quotient.y, { size: 32 }),
					numberToHex(length, { size: 32 }),
					evaluations,
				]),
			),
		) % BN254_R
	);
}

// EigenDABlob.verify's proof (224 bytes): q's commitment, p(z), and the openings of p and q at z
export type EigenDABlobProof = { quotient: G1; y: bigint; proof: G1; quotientProof: G1 };
export function encodeEigenDABlobProof(p: EigenDABlobProof): Hex {
	const g1 = (g: G1) => [numberToHex(g.x, { size: 32 }), numberToHex(g.y, { size: 32 })];
	return concatHex([...g1(p.quotient), numberToHex(p.y, { size: 32 }), ...g1(p.proof), ...g1(p.quotientProof)]);
}
