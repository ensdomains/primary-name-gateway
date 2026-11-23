import type { Address, Hex } from "viem";
import type { OutputRootProof } from "./op.js";
import type { TrieRow } from "./trie.js";

// JSON shapes served by registrar-indexer and consumed by registrar-gateway

// pending: commit seen on L1, snapshot taken, not yet usable (OP: game not yet a valid claim)
// valid: the verifier accepts it (OP: isGameClaimValid, Linea: finalized)
// invalid: OP game lost, was blacklisted, or its claim doesn't match L2
export type CommitStatus = "pending" | "valid" | "invalid";

export type CommitKind = "op" | "linea";

type CommitBase = {
	id: number; // OP: dispute game index, Linea: finalized L2 block
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

export type Commit = OPCommit | LineaCommit;

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
	chainId: number;
	kind: CommitKind;
	registrar: Address;
	syncedBlock: number; // changes are complete through this L2 block
	changeSeq: number; // latest change
	commits: { pending: number; valid: number; invalid: number };
	latestValid?: Pick<Commit, "id" | "l2Block" | "changeSeq" | "validAt">;
};

export type SnapshotPage = {
	id: number;
	rows: TrieRow[];
	next: string | null; // pass as ?after= for the next page
};
