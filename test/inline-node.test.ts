// Trie nodes under 32 bytes are embedded in their parent instead of referenced by hash.
// merkle-builder 0.2.0 encoded those references wrong, which broke Base's storage root around
// 2.3M events. Slots 247476 and 515151 share 9 key nibbles, so their leaves sit at depth 10 and,
// holding 1-byte values, encode to 31 bytes: indexer rows, gateway proofs and the verifier must agree.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { EthRowStorage, EthStorage } from "@ensdomains/merkle-builder";
import { SqlRowLog } from "@primary-name-gateway/registrar-indexer";
import { encodeMPTStorageProofs, proveSlot } from "@primary-name-gateway/shared";
import { type Hex, numberToBytes, numberToHex, zeroAddress } from "viem";

const SLOTS = [247476n, 515151n];
const OTHER = 1n; // absent, diverges at the root

let foundry: Foundry;
let verifier: Awaited<ReturnType<Foundry["deploy"]>>;

beforeAll(async () => {
	foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
	verifier = await foundry.deploy({ file: "OPFaultVerifier", args: [zeroAddress, 10, 0, 0] });
}, 60_000);

afterAll(() => foundry?.shutdown());

test("proofs through embedded nodes match EthStorage and verify on-chain", async () => {
	const eth = new EthStorage();
	const db = new Database(":memory:");
	const log = new SqlRowLog(db);
	const rows = new EthRowStorage((p) => log.head(p));
	for (const s of SLOTS) {
		eth.setStorage(numberToBytes(s, { size: 32 }), Uint8Array.of(1));
		rows.setStorage(numberToBytes(s, { size: 32 }), Uint8Array.of(1));
	}
	const { rows: changed, storageHash } = rows.commit();
	log.put(1, changed);
	expect(storageHash).toBe(eth.storageHash);

	const slots = [...SLOTS, OTHER];
	const proofs = slots.map((s) => proveSlot((p) => log.head(p), numberToBytes(s, { size: 32 })).proof);
	for (const [i, s] of slots.entries()) expect(proofs[i]).toEqual(eth.getProof(numberToBytes(s, { size: 32 })).proof);
	// the leaves are embedded: proof nodes under 32 bytes
	expect(proofs[0].some((n) => (n.length - 2) / 2 < 32)).toBeTrue();

	const values = (await verifier.verifyStorageValues(storageHash, slots, encodeMPTStorageProofs(proofs))) as Hex[];
	expect(values).toEqual([numberToHex(1, { size: 32 }), numberToHex(1, { size: 32 }), numberToHex(0, { size: 32 })]);
	db.close();
}, 30_000);
