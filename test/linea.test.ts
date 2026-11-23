// LineaStorageTrie (rows) vs merkle-builder's LineaStorage, and multiproofs vs real linea_getProof output.

import { describe, expect, test } from "bun:test";
import { LineaStorage } from "@ensdomains/merkle-builder";
import {
	type LineaPathProof,
	LineaStorageTrie,
	lineaAccountKey,
	lineaAccountValueHash,
	lineaMultiProofFromPath,
	lineaMultiProofRoot,
	proveLineaSlots,
	type RowFloor,
	type TrieRow,
} from "@primary-name-gateway/shared";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import FIXTURE from "../packages/contracts/test/fixtures/linea.json" with { type: "json" };

function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x80000000;
	};
}

// rows applied in order (what a gateway's store holds for the newest version)
class RowMap {
	readonly rows = new Map<string, Uint8Array>();
	apply(rows: TrieRow[]) {
		for (const { path, node } of rows) {
			if (node === null) this.rows.delete(path);
			else this.rows.set(path, hexToBytes(node));
		}
	}
	get = (path: string) => this.rows.get(path);
	floor: RowFloor = (prefix, before) => {
		let best: string | undefined;
		for (const path of this.rows.keys()) {
			if (path.startsWith(prefix) && path < before && (!best || path > best)) best = path;
		}
		return best === undefined ? undefined : { path: best, node: this.rows.get(best)! };
	};
}

describe("linea trie", () => {
	for (const seed of [1, 2, 3]) {
		test(`seed ${seed}: roots, rows and proofs match merkle-builder`, () => {
			const rand = rng(seed);
			const randomSlot = () => Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256));
			const oracle = new LineaStorage();
			const trie = new LineaStorageTrie();
			const rows = new RowMap();
			rows.apply(trie.commit()); // sentinels
			const known: Uint8Array[] = [];
			for (let block = 0; block < 25; block++) {
				for (let n = 1 + Math.floor(rand() * 8); n; n--) {
					const slot = known.length && rand() < 0.4 ? known[Math.floor(rand() * known.length)] : randomSlot();
					known.push(slot);
					const value =
						rand() < 0.25
							? new Uint8Array(0)
							: Uint8Array.from({ length: 1 + Math.floor(rand() * 32) }, () => Math.floor(rand() * 256));
					oracle.setStorage(slot, value);
					trie.setStorage(slot, value);
				}
				oracle.commit();
				rows.apply(trie.commit());
				expect(trie.storageRoot).toBe(oracle.storageRoot);

				// patched rows == a full snapshot of the trie
				const full = new Map([...trie.trie.rows()].map((r) => [r.path, r.node as Hex]));
				expect(new Map([...rows.rows].map(([p, v]) => [p, bytesToHex(v) as Hex]))).toEqual(full);
			}
			// proofs from rows
			const probe = [...known.slice(-12), randomSlot(), randomSlot()];
			for (const slot of probe) {
				const { proof, values } = proveLineaSlots(rows.get, rows.floor, [slot]);
				expect(lineaMultiProofRoot(proof)).toBe(trie.storageRoot);
				expect(bytesToHex(values[0])).toBe(
					bytesToHex(oracle.getStorage(slot).length ? toWord(oracle.getStorage(slot)) : new Uint8Array(0)),
				);
				const expected = oracle.getProof(slot);
				if ("proof" in expected) {
					// a single path: identical to linea_getProof once preimages are hashed
					expect(proof).toEqual(lineaMultiProofFromPath(expected as LineaPathProof));
				} else {
					expect(proof.indices).toEqual(
						[expected.leftLeafIndex, expected.rightLeafIndex].sort((a, b) => a - b).map(BigInt),
					);
				}
			}
			// all at once (shared path nodes)
			const batch = proveLineaSlots(rows.get, rows.floor, probe);
			expect(lineaMultiProofRoot(batch.proof)).toBe(trie.storageRoot);
			const single = probe.reduce((a, s) => a + proveLineaSlots(rows.get, rows.floor, [s]).proof.siblings.length, 0);
			expect(batch.proof.siblings.length).toBeLessThan(single);
		});
	}
});

function toWord(v: Uint8Array): Uint8Array {
	const w = new Uint8Array(32);
	w.set(v, 32 - v.length);
	return w;
}

describe("linea mainnet fixture", () => {
	const account = FIXTURE.accountProof as LineaPathProof;
	const leaf = hexToBytes(account.proof.proofRelatedNodes.at(-1) as Hex);

	test("account key and value hashes", () => {
		expect(bytesToHex(lineaAccountKey(FIXTURE.registrar as Hex))).toBe(bytesToHex(leaf.subarray(128, 160)));
		expect(bytesToHex(lineaAccountValueHash(hexToBytes(account.proof.value)))).toBe(
			bytesToHex(leaf.subarray(160, 192)),
		);
	});

	test("path => multiproof roots", () => {
		expect(lineaMultiProofRoot(lineaMultiProofFromPath(account))).toBe(FIXTURE.stateRoot as Hex);
		const storageRoot = bytesToHex(hexToBytes(account.proof.value).subarray(64, 96));
		expect(lineaMultiProofRoot(lineaMultiProofFromPath(FIXTURE.short.proof as LineaPathProof))).toBe(storageRoot);
	});
});
