// EigenDAInboxVerifier on a real Celo batcher transaction (fixture from scripts/eigen-fixture.ts): the
// registrar's storage root at the batch's parent L2 block, and what it refuses. EXPERIMENT.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { eigenDAPayloadPrefix, encodeMPTProof } from "@primary-name-gateway/shared";
import { type Address, bytesToHex, encodeAbiParameters, type Hex, hexToBytes, zeroAddress } from "viem";

type Fixture = {
	batcher: Address;
	inbox: Address;
	l1Block: number;
	l1Hash: Hex;
	l1Header: Hex;
	txIndex: number;
	txProof: Hex[];
	evaluations: Hex;
	blobProof: Hex;
	l2Header: Hex;
	registrar: Address;
	accountProof: Hex[];
	storageHash: Hex;
};
const f: Fixture = await Bun.file(`${import.meta.dir}/../packages/contracts/test/fixtures/eigen/celo.json`).json();

const PROOF = [
	{
		type: "tuple",
		components: [
			{ name: "l1Header", type: "bytes" },
			{ name: "txIndex", type: "uint256" },
			{ name: "txProof", type: "bytes[]" },
			{ name: "evaluations", type: "bytes" },
			{ name: "blobProof", type: "bytes" },
			{ name: "l2Header", type: "bytes" },
		],
	},
] as const;
const commitProof = (change: Partial<Fixture> = {}) => {
	const p = { ...f, ...change };
	return encodeAbiParameters(PROOF, [{ ...p, txIndex: BigInt(p.txIndex) }]);
};

let foundry: Foundry;
beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
}, 60_000);
afterAll(() => foundry?.shutdown());

async function deploy({ inbox = f.inbox, maxOriginLag = 3000, batcher = f.batcher } = {}) {
	const systemConfig = await foundry.deploy({ file: "MockOPBatchInbox", contract: "MockSystemConfig" });
	await foundry.confirm(systemConfig.setBatcher(batcher));
	const v = await foundry.deploy({
		file: "MockEigenDAInbox",
		contract: "EigenDAInboxVerifierHarness",
		args: [systemConfig.target, inbox, maxOriginLag, 8191],
	});
	await foundry.confirm(v.setL1BlockHash(f.l1Block, f.l1Hash));
	return v;
}

test("payload: Solidity matches TypeScript", async () => {
	const v = await deploy();
	expect(await v.payload(f.evaluations)).toBe(bytesToHex(eigenDAPayloadPrefix(hexToBytes(f.evaluations))));
});

test("verifies the registrar's storage root at the batch's parent block", async () => {
	const v = await deploy();
	const [root, gas] = await v.measure(commitProof(), f.registrar, encodeMPTProof(f.accountProof));
	expect(root).toBe(f.storageHash);
	console.log(`celo: verifyStorageRoot ${Number(gas).toLocaleString()} gas`);
}, 120_000);

test("refuses", async () => {
	const v = await deploy();
	const account = encodeMPTProof(f.accountProof);
	const check = (proof: Hex, error: RegExp, target: Address = f.registrar) =>
		expect(v.verifyStorageRoot(proof, target, account)).rejects.toThrow(error);
	await foundry.confirm(v.setL1BlockHash(f.l1Block, `0x${"11".repeat(32)}`));
	await check(commitProof(), /InvalidL1Header/);
	await foundry.confirm(v.setL1BlockHash(f.l1Block, f.l1Hash));
	await check(commitProof({ txIndex: f.txIndex + 1 }), /MerkleTrie|InvalidTransaction|NotBatcher/);
	const flip = (h: Hex, at: number) => `${h.slice(0, at)}${h[at] === "0" ? "1" : "0"}${h.slice(at + 1)}` as Hex;
	await check(commitProof({ evaluations: flip(f.evaluations, 2 + 64 * 3 + 40) }), /InvalidBlobProof/);
	await check(commitProof({ blobProof: flip(f.blobProof, 2 + 128 + 40) }), /InvalidBlobProof/);
	const l2 = f.l2Header;
	await check(
		commitProof({ l2Header: `${l2.slice(0, -2)}${l2.endsWith("00") ? "01" : "00"}` as Hex }),
		/InvalidL2Header/,
	);
	await check(commitProof(), /MerkleTrie|AccountNotFound/, zeroAddress);
	const notBatcher = await deploy({ batcher: "0x000000000000000000000000000000000000dEaD" });
	await expect(notBatcher.verifyStorageRoot(commitProof(), f.registrar, account)).rejects.toThrow(/NotBatcher/);
	const otherInbox = await deploy({ inbox: "0x000000000000000000000000000000000000bEEF" });
	await expect(otherInbox.verifyStorageRoot(commitProof(), f.registrar, account)).rejects.toThrow(/InvalidTransaction/);
	const strict = await deploy({ maxOriginLag: 0 });
	await expect(strict.verifyStorageRoot(commitProof(), f.registrar, account)).rejects.toThrow(
		/OutsideSequencingWindow/,
	);
}, 300_000);
