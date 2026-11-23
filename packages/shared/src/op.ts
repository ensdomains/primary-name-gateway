import { type Hex, hexToBigInt, keccak256, parseAbi, size, slice, encodeAbiParameters } from "viem";

export const ASR_ABI = parseAbi([
	"function disputeGameFactory() view returns (address)",
	"function respectedGameType() view returns (uint32)",
	"function isGameClaimValid(address) view returns (bool)",
	"function isGameBlacklisted(address) view returns (bool)",
	"function getAnchorRoot() view returns (bytes32, uint256)",
]);

export const FACTORY_ABI = parseAbi([
	"function gameCount() view returns (uint256)",
	"function gameAtIndex(uint256) view returns (uint32 gameType, uint64 timestamp, address proxy)",
]);

export const GAME_ABI = parseAbi([
	"function rootClaim() view returns (bytes32)",
	"function extraData() view returns (bytes)",
	"function l2SequenceNumber() view returns (uint256)",
	"function status() view returns (uint8)",
	"function createdAt() view returns (uint64)",
	"function resolvedAt() view returns (uint64)",
]);

export const GAME_STATUS_CHALLENGER_WINS = 1;

export const L2_TO_L1_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

export type OutputRootProof = {
	version: Hex;
	stateRoot: Hex;
	messagePasserStorageRoot: Hex;
	latestBlockhash: Hex;
};

export function hashOutputRootProof(p: OutputRootProof): Hex {
	return keccak256(
		encodeAbiParameters(
			[{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
			[p.version, p.stateRoot, p.messagePasserStorageRoot, p.latestBlockhash],
		),
	);
}

// what a game's root claim says about one L2
export type GameClaim =
	| { kind: "super"; superRoot: Hex; timestamp: bigint; outputRoot: Hex }
	| { kind: "output"; l2BlockNumber: bigint; outputRoot: Hex };

// SuperRootV1 = version(1) . timestamp(8) . [chainId(32) . outputRoot(32)]*
// for super root games, extraData is the super root preimage (keccak(extraData) == rootClaim)
// for output root games, extraData starts with the l2 block number and rootClaim is the output root
export function decodeGameClaim(rootClaim: Hex, extraData: Hex, chainId: number): GameClaim | undefined {
	if (keccak256(extraData) === rootClaim) {
		const n = size(extraData);
		if (n < 9 || (n - 9) % 64 || slice(extraData, 0, 1) !== "0x01") return;
		const timestamp = hexToBigInt(slice(extraData, 1, 9));
		for (let pos = 9; pos < n; pos += 64) {
			if (hexToBigInt(slice(extraData, pos, pos + 32)) === BigInt(chainId)) {
				return { kind: "super", superRoot: extraData, timestamp, outputRoot: slice(extraData, pos + 32, pos + 64) };
			}
		}
		return;
	}
	if (size(extraData) < 32) return;
	return { kind: "output", l2BlockNumber: hexToBigInt(slice(extraData, 0, 32)), outputRoot: rootClaim };
}
