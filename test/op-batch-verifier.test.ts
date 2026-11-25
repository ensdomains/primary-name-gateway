// OPBatchInboxVerifier on real mainnet batcher transactions (fixtures from scripts/op-batch-fixture.ts):
// the registrar's storage root at the batch's parent L2 block, and what it refuses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import {
	encodeMPTProof,
	encodeOPBatchInboxCommitProof,
	type OPBatchInboxCommitProof,
} from "@primary-name-gateway/shared";
import { type Address, type Hex, zeroAddress } from "viem";

type Fixture = {
	inbox: Address;
	batcher: Address;
	l1Block: number;
	l1Hash: Hex;
	l1Header: Hex;
	txIndex: number;
	txProof: Hex[];
	blobIndex: number;
	commitment: Hex;
	fieldElements: Hex;
	blobProof: Hex;
	l2Header: Hex;
	registrar: Address;
	accountProof: Hex[];
	storageHash: Hex;
};

const fixture = async (chain: string): Promise<Fixture> =>
	Bun.file(`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/${chain}-blob.json`).json();

const commitProof = (f: Fixture, change: Partial<OPBatchInboxCommitProof> = {}) =>
	encodeOPBatchInboxCommitProof({
		l1Header: f.l1Header,
		txIndex: f.txIndex,
		txProof: f.txProof,
		blobIndex: f.blobIndex,
		commitment: f.commitment,
		fieldElements: f.fieldElements,
		blobProof: f.blobProof,
		l2Header: f.l2Header,
		...change,
	});

let foundry: Foundry;
beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
}, 60_000);
afterAll(() => foundry?.shutdown());

async function deploy(f: Fixture, { inbox = f.inbox, maxOriginLag = 3000, batcher = f.batcher } = {}) {
	const systemConfig = await foundry.deploy({ file: "MockOPBatchInbox", contract: "MockSystemConfig" });
	await foundry.confirm(systemConfig.setBatcher(batcher));
	const verifier = await foundry.deploy({
		file: "MockOPBatchInbox",
		contract: "OPBatchInboxVerifierHarness",
		args: [systemConfig.target, inbox, maxOriginLag, 8191],
	});
	await foundry.confirm(verifier.setL1BlockHash(f.l1Block, f.l1Hash));
	return verifier;
}

describe.each(["op", "base"])("%s", (chain) => {
	test("verifies the registrar's storage root at the batch's parent block", async () => {
		const f = await fixture(chain);
		const v = await deploy(f);
		const [root, gas] = await v.measure(commitProof(f), f.registrar, encodeMPTProof(f.accountProof));
		expect(root).toBe(f.storageHash);
		console.log(`${chain}: verifyStorageRoot ${Number(gas).toLocaleString()} gas`);
	}, 120_000);

	test("refuses", async () => {
		const f = await fixture(chain);
		const v = await deploy(f);
		const account = encodeMPTProof(f.accountProof);
		const check = (proof: Hex, error: RegExp, target: Address = f.registrar) =>
			expect(v.verifyStorageRoot(proof, target, account)).rejects.toThrow(error);
		// an L1 block it doesn't know
		await foundry.confirm(v.setL1BlockHash(f.l1Block, `0x${"11".repeat(32)}`));
		await check(commitProof(f), /InvalidL1Header/);
		await foundry.confirm(v.setL1BlockHash(f.l1Block, f.l1Hash));
		// someone else's transaction, or the wrong one
		await check(commitProof(f, { txIndex: f.txIndex + 1 }), /MerkleTrie|InvalidTransaction/);
		await check(commitProof(f, { blobIndex: 99 }), /InvalidTransaction/);
		await check(commitProof(f, { blobIndex: 1 }), /InvalidBlobProof/); // another blob's versioned hash
		// a header that isn't the batch's parent
		const l2 = f.l2Header;
		await check(
			commitProof(f, { l2Header: `${l2.slice(0, -2)}${l2.endsWith("00") ? "01" : "00"}` as Hex }),
			/InvalidL2Header/,
		);
		// an account the proof isn't for
		await check(commitProof(f), /MerkleTrie|AccountNotFound/, zeroAddress);
		// other batcher, other inbox, too old an origin
		const notBatcher = await deploy(f, { batcher: "0x000000000000000000000000000000000000dEaD" });
		await expect(notBatcher.verifyStorageRoot(commitProof(f), f.registrar, account)).rejects.toThrow(/NotBatcher/);
		const otherInbox = await deploy(f, { inbox: "0x000000000000000000000000000000000000bEEF" });
		await expect(otherInbox.verifyStorageRoot(commitProof(f), f.registrar, account)).rejects.toThrow(
			/InvalidTransaction/,
		);
		const strict = await deploy(f, { maxOriginLag: 0 });
		await expect(strict.verifyStorageRoot(commitProof(f), f.registrar, account)).rejects.toThrow(
			/OutsideSequencingWindow/,
		);
	}, 300_000);
});
