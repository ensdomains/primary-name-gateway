// Commit proof decoders (bun run prove reads the proof's L2 block from them) against the encoders.

import { expect, test } from "bun:test";
import {
	decodeOPBatchInboxCommitProof,
	decodeOPFaultCommitProof,
	encodeOPBatchInboxCommitProof,
	encodeOPFaultCommitProof,
	type OPBatchInboxCommitProof,
} from "@primary-name-gateway/shared";
import { type Hex, keccak256, stringToHex } from "viem";

test("OP fault commit proof round-trips", () => {
	const word = (s: string) => keccak256(stringToHex(s));
	const p = {
		game: "0x2F32D58C45fDC217D45121f47886D6186D3C7Cc8" as const,
		superRoot: "0x1234" as Hex,
		outputRootProof: {
			version: word("v"),
			stateRoot: word("s"),
			messagePasserStorageRoot: word("m"),
			latestBlockhash: word("b"),
		},
	};
	expect(decodeOPFaultCommitProof(encodeOPFaultCommitProof(p))).toEqual(p);
});

test("batch inbox commit proof round-trips (mainnet fixture)", async () => {
	const f = await Bun.file(`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/op-blob.json`).json();
	const p: OPBatchInboxCommitProof = {
		l1Header: f.l1Header,
		txIndex: f.txIndex,
		txProof: f.txProof,
		blobIndex: f.blobIndex,
		commitment: f.commitment,
		fieldElements: f.fieldElements,
		blobProofs: f.proofs,
		l2Header: f.l2Header,
	};
	expect(decodeOPBatchInboxCommitProof(encodeOPBatchInboxCommitProof(p))).toEqual(p);
});
