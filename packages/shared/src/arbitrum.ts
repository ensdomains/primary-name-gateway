// Arbitrum (BoLD): assertions on L1 name L2 blocks. See docs/arbitrum.md and ArbitrumVerifier.sol.
// https://github.com/OffchainLabs/nitro-contracts (src/rollup/Assertion.sol, AssertionState.sol, IRollupCore.sol)

import { decodeAbiParameters, encodeAbiParameters, encodePacked, type Hex, keccak256, parseAbi } from "viem";

const STRUCTS = [
	"struct GlobalState { bytes32[2] bytes32Vals; uint64[2] u64Vals; }",
	"struct AssertionState { GlobalState globalState; uint8 machineStatus; bytes32 endHistoryRoot; }",
	"struct ConfigData { bytes32 wasmModuleRoot; uint256 requiredStake; address challengeManager; uint64 confirmPeriodBlocks; uint64 nextInboxPosition; }",
	"struct BeforeStateData { bytes32 prevPrevAssertionHash; bytes32 sequencerBatchAcc; ConfigData configData; }",
	"struct AssertionInputs { BeforeStateData beforeStateData; AssertionState beforeState; AssertionState afterState; }",
	"struct AssertionNode { uint64 firstChildBlock; uint64 secondChildBlock; uint64 createdAtBlock; bool isFirstChild; uint8 status; bytes32 configHash; }",
] as const;

export const BOLD_ROLLUP_ABI = parseAbi([
	...STRUCTS,
	"function latestConfirmed() view returns (bytes32)",
	"function confirmPeriodBlocks() view returns (uint64)",
	"function getAssertion(bytes32 assertionHash) view returns (AssertionNode)",
	"event AssertionCreated(bytes32 indexed assertionHash, bytes32 indexed parentAssertionHash, AssertionInputs assertion, bytes32 afterInboxBatchAcc, uint256 inboxMaxCount, bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks)",
	"event AssertionConfirmed(bytes32 indexed assertionHash, bytes32 blockHash, bytes32 sendRoot)",
]);

export const ASSERTION_PENDING = 1;
export const ASSERTION_CONFIRMED = 2;
export const MACHINE_FINISHED = 1;

export type AssertionState = {
	globalState: { bytes32Vals: readonly [Hex, Hex]; u64Vals: readonly [bigint, bigint] }; // [L2 block hash, send root]
	machineStatus: number;
	endHistoryRoot: Hex;
};

const ASSERTION_STATE = {
	type: "tuple",
	components: [
		{
			name: "globalState",
			type: "tuple",
			components: [
				{ name: "bytes32Vals", type: "bytes32[2]" },
				{ name: "u64Vals", type: "uint64[2]" },
			],
		},
		{ name: "machineStatus", type: "uint8" },
		{ name: "endHistoryRoot", type: "bytes32" },
	],
} as const;

export function assertionStateHash(s: AssertionState): Hex {
	return keccak256(encodeAbiParameters([ASSERTION_STATE], [s]));
}

export function assertionHash(parent: Hex, afterStateHash: Hex, afterInboxBatchAcc: Hex): Hex {
	return keccak256(encodePacked(["bytes32", "bytes32", "bytes32"], [parent, afterStateHash, afterInboxBatchAcc]));
}

// ArbitrumCommitProof (see ArbitrumVerifier.sol): from a confirmed anchor, (afterStateHash,
// afterInboxBatchAcc) per assertion to the commit's, its after state, and the L2 header it names
export type ArbitrumCommitProof = { anchor: Hex; chain: Hex[]; afterState: AssertionState; l2Header: Hex };

const COMMIT_PROOF = [
	{
		type: "tuple",
		components: [
			{ name: "anchor", type: "bytes32" },
			{ name: "chain", type: "bytes32[]" },
			{ name: "afterState", ...ASSERTION_STATE },
			{ name: "l2Header", type: "bytes" },
		],
	},
] as const;

export function encodeArbitrumCommitProof(p: ArbitrumCommitProof): Hex {
	return encodeAbiParameters(COMMIT_PROOF, [p]);
}

export function decodeArbitrumCommitProof(proof: Hex): ArbitrumCommitProof {
	const p = decodeAbiParameters(COMMIT_PROOF, proof)[0];
	return { ...p, chain: [...p.chain] };
}
