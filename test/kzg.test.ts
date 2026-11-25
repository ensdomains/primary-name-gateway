// The indexer's KZG (noble) must produce what OPBlob.verify accepts with the point evaluation precompile:
// a synthetic blob's commitment and the batched proof of its first elements, on anvil. (Downloads the
// trusted setup to data/kzg/ on first run.)

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { KZG } from "@primary-name-gateway/registrar-indexer";
import { bytesToHex, type Hex } from "viem";

let foundry: Foundry;
let harness: Awaited<ReturnType<Foundry["deploy"]>>;
let kzg: KZG;

beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
	harness = await foundry.deploy({ file: "OPBatchHarness" });
	kzg = await KZG.load();
}, 120_000);

afterAll(() => foundry?.shutdown());

function randomBlob(seed: number): Uint8Array {
	return Uint8Array.from({ length: 4096 * 32 }, (_, i) => {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return i % 32 ? seed & 0xff : seed & 0x3f; // below the BLS modulus
	});
}

const flip = (h: Hex, at: number) => `${h.slice(0, at)}${h[at] === "0" ? "1" : "0"}${h.slice(at + 1)}` as Hex;

test("a batched proof of a blob's first field elements verifies with the precompile", async () => {
	const blob = randomBlob(3);
	const commitment = kzg.commitment(blob);
	const versionedHash = KZG.versionedHash(commitment);
	for (const n of [1, 4, 64, 4096]) {
		const proof = kzg.proveFieldElements(blob, commitment, n);
		const fieldElements = bytesToHex(blob.subarray(0, 32 * n));
		const gas = await harness.verifyBlob(versionedHash, commitment, fieldElements, proof);
		console.log(`${n} field elements: ${Number(gas).toLocaleString()} gas`);
	}
	const n = 64;
	const proof = kzg.proveFieldElements(blob, commitment, n);
	const fieldElements = bytesToHex(blob.subarray(0, 32 * n));
	// any other element, quotient, value or opening fails
	for (const at of [2 + 64 * 0 + 10, 2 + 64 * 37 + 63]) {
		await expect(harness.verifyBlob(versionedHash, commitment, flip(fieldElements, at), proof)).rejects.toThrow(
			/InvalidBlobProof/,
		);
	}
	for (const at of [2 + 20, 2 + 96 + 40, 2 + 160 + 20, 2 + 256 + 20]) {
		await expect(harness.verifyBlob(versionedHash, commitment, fieldElements, flip(proof, at))).rejects.toThrow(
			/InvalidBlob/,
		);
	}
	// the elements of another blob, with a proof for that blob, against this blob's hash
	const other = randomBlob(4);
	const otherProof = kzg.proveFieldElements(other, kzg.commitment(other), n);
	await expect(
		harness.verifyBlob(versionedHash, commitment, bytesToHex(other.subarray(0, 32 * n)), otherProof),
	).rejects.toThrow(/InvalidBlobProof/);
	// not a power of two, or a proof of the wrong length
	await expect(
		harness.verifyBlob(versionedHash, commitment, bytesToHex(blob.subarray(0, 32 * 40)), proof),
	).rejects.toThrow(/InvalidBlob/);
	await expect(harness.verifyBlob(versionedHash, commitment, fieldElements, proof.slice(0, -2))).rejects.toThrow(
		/InvalidBlob/,
	);
}, 300_000);
