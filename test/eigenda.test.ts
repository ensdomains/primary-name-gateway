// EigenDA batches (docs/eigenda-inbox.md): the certificate in a real Celo batcher transaction, and a
// synthetic blob round trip: an OP frame encoded as an EigenDA payload, turned into coefficients the
// way EigenDA's client does (inverse FFT), then evaluated, decoded and proven by the indexer's
// eigenda.ts and checked by EigenDABlob.verify on anvil. (Downloads the first points of EigenDA's
// setup to data/eigenda/ on first run.)

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { bn254 } from "@noble/curves/bn254";
import { EigenDAKZG } from "@primary-name-gateway/registrar-indexer";
import {
	channelStart,
	decodeEigenDACalldata,
	eigenDABlobKey,
	eigenDAPayloadPrefix,
	rootOfUnity,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { fft } from "../packages/registrar-indexer/src/eigenda.js";

const Fr = bn254.fields.Fr;
const fixtures = `${import.meta.dir}/../packages/contracts/test/fixtures`;

let foundry: Foundry;
let harness: Awaited<ReturnType<Foundry["deploy"]>>;
beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
	harness = await foundry.deploy({ file: "EigenDABlobHarness" });
}, 60_000);
afterAll(() => foundry?.shutdown());

test("a real certificate: commitment, length, relay and blob key", async () => {
	const f = await Bun.file(`${fixtures}/eigen/celo.json`).json();
	const cert = decodeEigenDACalldata(f.calldata);
	expect(cert).toBeDefined();
	expect(cert?.length).toBe(f.blobLength);
	expect(cert?.commitment).toEqual({ x: BigInt(f.commitment.x), y: BigInt(f.commitment.y) });
	expect(cert?.relayKeys).toEqual([0]);
	expect(eigenDABlobKey(cert!)).toBe(f.blobKey); // the relay served the blob under this key
	expect(decodeEigenDACalldata(`0x01010001${f.calldata.slice(10)}`)).toBeUndefined(); // another certificate version
	expect(decodeEigenDACalldata("0x00")).toBeUndefined(); // Ethereum DA
});

test("a synthetic blob: encode, evaluate, decode, prove, verify", async () => {
	const n = 256;
	// an EigenDA payload: OP batcher data (derivation version 0, then frame 0 of the Optimism fixture)
	const frame = new Uint8Array(await Bun.file(`${fixtures}/op-batch/op-frame0.bin`).arrayBuffer());
	const channel = new Uint8Array(1 + 16 + 2 + 4 + 2000);
	channel.set([0], 0);
	channel.set(hexToBytes(`0x${"ab".repeat(16)}`), 1); // channel id
	new DataView(channel.buffer).setUint32(19, frame.length); // frame number 0, frame length
	channel.set(frame.subarray(0, 2000), 23);
	const elements = 1 + Math.ceil(channel.length / 31);
	const evals = new Array<bigint>(n).fill(0n);
	const header = new Uint8Array(32);
	new DataView(header.buffer).setUint32(2, channel.length);
	evals[0] = BigInt(bytesToHex(header));
	for (let i = 1; i < elements; i++) {
		const e = new Uint8Array(32);
		e.set(channel.subarray(31 * (i - 1), 31 * i), 1);
		evals[i] = BigInt(bytesToHex(e));
	}
	// coefficients = inverse FFT of the evaluations
	const nInv = Fr.inv(BigInt(n));
	const coeffs = fft(evals, Fr.inv(rootOfUnity(n))).map((c) => Fr.mul(c, nInv));
	const blob = new Uint8Array(32 * n);
	coeffs.forEach((c, i) => {
		blob.set(hexToBytes(`0x${c.toString(16).padStart(64, "0")}`), 32 * i);
	});

	const kzg = await EigenDAKZG.load(n);
	const commitment = kzg.commit(coeffs);
	const payload = eigenDAPayloadPrefix(kzg.evaluations(blob));
	expect(bytesToHex(payload)).toBe(bytesToHex(channel));
	expect(channelStart(payload).compressed.length).toBe(2000 - 1);

	const k = 20;
	const { evaluations, proof } = kzg.prove(blob, commitment, k);
	const gas = await harness.verify(commitment.x, commitment.y, n, evaluations, proof);
	console.log(`${k} evaluations of a ${n}-symbol blob: ${Number(gas).toLocaleString()} gas`);
	const flip = (h: Hex, at: number) => `${h.slice(0, at)}${h[at] === "0" ? "1" : "0"}${h.slice(at + 1)}` as Hex;
	await expect(
		harness.verify(commitment.x, commitment.y, n, flip(evaluations, 2 + 64 * 9 + 20), proof),
	).rejects.toThrow(/InvalidBlobProof/);
	await expect(harness.verify(commitment.x, commitment.y, n * 2, evaluations, proof)).rejects.toThrow(
		/InvalidBlobProof/,
	);
	await expect(harness.verify(commitment.x, commitment.y, n, evaluations, flip(proof, 2 + 64 + 30))).rejects.toThrow(
		/InvalidBlobProof/,
	);
}, 120_000);
