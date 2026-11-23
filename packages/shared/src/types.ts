import type { Address, Hex } from "viem";
import type { OutputRootProof } from "./op.js";
import type { TrieRow } from "./trie.js";

// JSON shapes served by registrar-indexer and consumed by registrar-gateway

// pending: game created, snapshot taken, not yet a valid claim on L1
// valid: anchorStateRegistry.isGameClaimValid(game) is true
// invalid: game lost, was blacklisted, or its claim doesn't match L2
export type CommitStatus = "pending" | "valid" | "invalid";

export type Commit = {
	gameIndex: number;
	game: Address;
	gameType: number;
	createdAt: number; // L1 timestamp
	l2SequenceNumber: string; // bigint
	l2Block: number;
	superRoot: Hex; // "0x" for output root games
	outputRootProof: OutputRootProof;
	accountProof: Hex[]; // registrar account at l2Block (eth_getProof)
	storageHash: Hex; // registrar storage root at l2Block
	changeSeq: number; // the trie at l2Block = changes [1, changeSeq]
	status: CommitStatus;
	validAt?: number; // unix seconds (wall-clock) when the indexer first saw it valid
};

// one NameForAddrChanged event, in chain order
export type Change = {
	seq: number; // 1-based, contiguous
	block: number;
	logIndex: number;
	addr: Address;
	name: Hex; // raw bytes (not necessarily valid UTF-8)
};

export type IndexerStatus = {
	chainId: number;
	registrar: Address;
	syncedBlock: number; // changes are complete through this L2 block
	changeSeq: number; // latest change
	commits: { pending: number; valid: number; invalid: number };
	latestValid?: Pick<Commit, "gameIndex" | "l2Block" | "l2SequenceNumber" | "changeSeq" | "validAt">;
};

export type SnapshotPage = {
	gameIndex: number;
	rows: TrieRow[];
	next: string | null; // pass as ?after= for the next page
};
