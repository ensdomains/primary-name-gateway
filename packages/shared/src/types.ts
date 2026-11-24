import type { Address, Hex } from "viem";
import type { OutputRootProof } from "./op.js";
import type { TrieRow } from "./trie.js";

// JSON shapes served by registrar-indexer and consumed by registrar-gateway

// pending: commit seen on L1, snapshot taken, not yet usable (OP: game not yet a valid claim)
// valid: the verifier accepts it (OP: isGameClaimValid, Linea: finalized)
// invalid: OP game lost, was blacklisted, or its claim doesn't match L2
export type CommitStatus = "pending" | "valid" | "invalid";

export type CommitKind = "op" | "linea" | "inbox" | "arbitrum";

type CommitBase = {
	id: number; // OP: dispute game index, Linea: finalized L2 block, inbox: see InboxCommit
	kind: CommitKind;
	createdAt: number; // L1 timestamp
	l2Block: number;
	storageHash: Hex; // registrar storage root at l2Block
	changeSeq: number; // the trie at l2Block = changes [1, changeSeq]
	status: CommitStatus;
	validAt?: number; // unix seconds (wall-clock) when the indexer first saw it valid
	// captured by the indexer when it sees the commit (the L2 may not keep this state for long),
	// ABI-encoded for the chain's IL2StorageVerifier
	commitProof: Hex;
	accountProof: Hex;
};

export type OPCommit = CommitBase & {
	kind: "op";
	game: Address;
	gameType: number;
	l2SequenceNumber: string; // bigint
	superRoot: Hex; // "0x" for output root games
	outputRootProof: OutputRootProof;
};

export type LineaCommit = CommitBase & {
	kind: "linea";
	stateRoot: Hex; // LineaRollup.stateRootHashes(l2Block)
	l1Block: number; // where DataFinalizedV3 was emitted
};

// a batcher blob that starts a channel; the L2 block is the batch's parent
// id = l1Block * 10000 + txIndex * 10 + blobIndex
export type InboxCommit = CommitBase & {
	kind: "inbox";
	l1Block: number;
	tx: Hex;
	blobIndex: number;
	l2Hash: Hex;
	batch: "singular" | "span";
};

// an Arbitrum assertion; id = L1 block * 10000 + log index of its AssertionCreated
export type ArbitrumCommit = CommitBase & {
	kind: "arbitrum";
	assertionHash: Hex;
	parentAssertionHash: Hex;
	afterStateHash: Hex;
	afterInboxBatchAcc: Hex;
	l1Block: number; // createdAtBlock
};

export type Commit = OPCommit | LineaCommit | InboxCommit | ArbitrumCommit;

// one registrar event, in chain order (see docs/registrar.md)
//   name:  NameForAddrChanged(addr, name)
//   owner: OwnershipTransferred(_, addr)  (name is "0x")
export type Change = {
	seq: number; // 1-based, contiguous
	block: number;
	logIndex: number;
	kind: "name" | "owner";
	addr: Address;
	name: Hex; // raw bytes (not necessarily valid UTF-8)
};

export type IndexerStatus = {
	kind: CommitKind;
	l1ChainId: number; // where its commits are
	l2ChainId: number;
	l2BlockMs?: number; // the L2's current block time (OP Stack: Base is 200 ms since Denim)
	minAgeSec?: number; // OP: unchallenged games this old are accepted before finality; the verifier must match
	minAgeBlocks?: number; // Arbitrum: unchallenged assertions this many L1 blocks old, likewise
	registrar: Address;
	syncedBlock: number; // changes are complete through this L2 block
	changeSeq: number; // latest change
	syncingTo?: number; // while it syncs events: the L2 block it's syncing to
	commits: { pending: number; valid: number; invalid: number };
	latestValid?: Pick<Commit, "id" | "l2Block" | "changeSeq" | "validAt">;
};

export type SnapshotPage = {
	id: number;
	rows: TrieRow[];
	next: string | null; // pass as ?after= for the next page
};
