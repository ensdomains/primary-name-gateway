// The indexer's KZG (noble) must produce what the point evaluation precompile accepts: a synthetic
// blob's commitment and per-element proofs go through OPBlob.verify on anvil. (Downloads the
// trusted setup to data/kzg/ on first run.)

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { KZG } from "@primary-name-gateway/registrar-indexer";
import { bytesToHex } from "viem";

let foundry: Foundry;
let harness: Awaited<ReturnType<Foundry["deploy"]>>;
let kzg: KZG;

beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
	harness = await foundry.deploy({ file: "OPBatchHarness" });
	kzg = await KZG.load();
}, 120_000);

afterAll(() => foundry?.shutdown());

test("proofs of a blob's first field elements verify with the precompile", async () => {
	let seed = 3;
	const blob = Uint8Array.from({ length: 4096 * 32 }, (_, i) => {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return i % 32 ? seed & 0xff : seed & 0x3f; // below the BLS modulus
	});
	const commitment = kzg.commitment(blob);
	const versionedHash = KZG.versionedHash(commitment);
	const n = 8;
	const proofs = Array.from({ length: n }, (_, i) => kzg.proveFieldElement(blob, i));
	const fieldElements = bytesToHex(blob.subarray(0, 32 * n));
	expect(Number(await harness.verifyBlob(versionedHash, commitment, fieldElements, proofs))).toBeGreaterThan(0);
	// a proof for another element doesn't verify
	const swapped = [...proofs];
	[swapped[0], swapped[1]] = [swapped[1], swapped[0]];
	await expect(harness.verifyBlob(versionedHash, commitment, fieldElements, swapped)).rejects.toThrow(
		/InvalidBlobProof/,
	);
}, 120_000);
