import { type Address, createPublicClient, http, type PublicClient } from "viem";
import { OWNABLE_LAYOUT, PLAIN_LAYOUT, type RegistrarLayout } from "./registrar.js";

export type ChainInfo = {
	id: number;
	name: string;
	drpcSlug: string;
	alchemySlug: string;
	infuraSlug?: string;
	publicRPC?: string; // keyless: what "public" returns, and the last resort for the other purposes
	publicFallback?: false; // the public RPC is too limited to be that last resort: only "public" uses it
	wideLogsRPC?: string; // a public endpoint with wide eth_getLogs, preferred for "logs" over keyed providers
	logStep?: number; // eth_getLogs block range
};

// an L1: also has a consensus layer, whose beacon API serves blobs (the batch inbox reads them)
export type L1ChainInfo = ChainInfo & {
	publicBeacon?: string;
};

export const MAINNET: L1ChainInfo = {
	id: 1,
	name: "mainnet",
	drpcSlug: "ethereum",
	alchemySlug: "eth-mainnet",
	infuraSlug: "mainnet",
	publicRPC: "https://ethereum-rpc.publicnode.com",
	publicBeacon: "https://ethereum-beacon-api.publicnode.com",
};

export const OPTIMISM: ChainInfo = {
	id: 10,
	name: "optimism",
	drpcSlug: "optimism",
	alchemySlug: "opt-mainnet",
	infuraSlug: "optimism-mainnet",
	publicRPC: "https://mainnet.optimism.io",
	logStep: 500000, // the widest range; each range is sized from the last one's log density
};

export const BASE: ChainInfo = {
	id: 8453,
	name: "base",
	drpcSlug: "base",
	alchemySlug: "base-mainnet",
	infuraSlug: "base-mainnet",
	publicRPC: "https://mainnet.base.org",
	publicFallback: false, // rate limits eth_getLogs: the indexer needs a key
	logStep: 500000,
};

export const LINEA: ChainInfo = {
	id: 59144,
	name: "linea",
	drpcSlug: "linea",
	alchemySlug: "linea-mainnet",
	infuraSlug: "linea-mainnet",
	publicRPC: "https://rpc.linea.build",
	logStep: 500000,
};

export const ARBITRUM: ChainInfo = {
	id: 42161,
	name: "arbitrum",
	drpcSlug: "arbitrum",
	alchemySlug: "arb-mainnet",
	infuraSlug: "arbitrum-mainnet",
	publicRPC: "https://arb1.arbitrum.io/rpc",
	// eth_getLogs over 10M blocks (Infura: 10k, drpc free: 100): the registrar's history is 177M blocks
	wideLogsRPC: "https://arb1.arbitrum.io/rpc",
	logStep: 10_000_000,
};

type DeploymentBase = {
	l1: L1ChainInfo;
	l2: ChainInfo;
	L2ReverseRegistrar: Address;
	layout: RegistrarLayout; // see docs/registrar.md
	registrarCreatedAtBlock: number; // first L2 block to scan for events
};

// An OP Stack L2's block times, as segments: from `block` (whose timestamp is `timestamp`, in whole
// seconds) one block every `ms`, up to the next segment. Header timestamps stay in whole seconds, so
// with blocks under a second apart several blocks share one (Base since Denim: 5 per second).
export type BlockSchedule = readonly { block: number; timestamp: number; ms: number }[];

// the blocks whose header timestamp is `timestamp`: [first, last], or undefined if none
export function blocksAtTimestamp(schedule: BlockSchedule, timestamp: number): [number, number] | undefined {
	for (let i = schedule.length - 1; i >= 0; i--) {
		const s = schedule[i];
		if (timestamp < s.timestamp) continue;
		const end = schedule[i + 1]?.block ?? Number.POSITIVE_INFINITY;
		const first = s.block + Math.ceil(((timestamp - s.timestamp) * 1000) / s.ms);
		const last = Math.min(end, s.block + Math.ceil(((timestamp + 1 - s.timestamp) * 1000) / s.ms)) - 1;
		return first <= last ? [first, last] : undefined;
	}
}

// Bedrock: https://specs.optimism.io/protocol/rollup-node.html
const OP_MAINNET_BLOCKS: BlockSchedule = [{ block: 105235063, timestamp: 1686068903, ms: 2000 }];
// Denim (200 ms blocks): first block 53,556,127 at 2026-11-05 18:00:01 UTC, checked against Base's headers
// (`timestampMs`). https://docs.base.org/upgrades/denim/200ms-blocks
const BASE_BLOCKS: BlockSchedule = [
	{ block: 0, timestamp: 1686789347, ms: 2000 },
	{ block: 53556127, timestamp: 1793901601, ms: 200 },
];

// an L2 whose state is committed to L1 via OP dispute games (Merkle-Patricia tries)
export type OPDeployment = DeploymentBase & {
	kind: "op";
	AnchorStateRegistry: Address;
	l2Blocks: BlockSchedule; // super root games name a timestamp
	gameFinalitySec: number; // typical time from game creation to isGameClaimValid (sets indexer defaults)
};

// Linea: finalized (ZK proven) state roots on L1 (sparse Merkle tries, linea_getProof)
export type LineaDeployment = DeploymentBase & {
	kind: "linea";
	LineaRollup: Address;
};

// an OP Stack L2 proven from its batcher's posts (OPBatchInboxVerifier, research: docs/op-batch-inbox.md)
export type InboxDeployment = DeploymentBase & {
	kind: "inbox";
	SystemConfig: Address; // batcherHash()
	BatchInbox: Address;
	l2Blocks: BlockSchedule; // starts at the rollup genesis: span batches' timestamps are relative to it
};

// Arbitrum (BoLD): assertions on L1 name L2 blocks (ArbitrumVerifier, docs/arbitrum.md)
export type ArbitrumDeployment = DeploymentBase & {
	kind: "arbitrum";
	Rollup: Address; // RollupProxy: latestConfirmed(), getAssertion(), AssertionCreated
};

export type Deployment = OPDeployment | LineaDeployment | InboxDeployment | ArbitrumDeployment;

// https://docs.optimism.io/superchain/addresses
// https://docs.ens.domains/ensip/19/#annex-supported-chains
export const OP_MAINNET: OPDeployment = {
	kind: "op",
	l1: MAINNET,
	l2: OPTIMISM,
	AnchorStateRegistry: "0x23B2C62946350F4246f9f9D027e071f0264FD113",
	L2ReverseRegistrar: "0x0000000000D8e504002cC26E3Ec46D81971C1664",
	layout: PLAIN_LAYOUT,
	registrarCreatedAtBlock: 137403854,
	l2Blocks: OP_MAINNET_BLOCKS,
	gameFinalitySec: 7 * 86400, // 3.5d clock + 3.5d airgap
};

// Base: output root games of type 621 (AggregateVerifier: TEE + ZK multiproofs), valid after ~5 days.
// https://github.com/base/contracts/blob/main/src/L1/proofs/AggregateVerifier.sol
// https://docs.base.org/base-chain/network-information/base-contracts
export const BASE_MAINNET: OPDeployment = {
	kind: "op",
	l1: MAINNET,
	l2: BASE,
	AnchorStateRegistry: "0x909f6cf47ed12f010A796527f562bFc26C7F4E72",
	L2ReverseRegistrar: "0x0000000000D8e504002cC26E3Ec46D81971C1664",
	layout: OWNABLE_LAYOUT, // L2ReverseRegistrarWithMigration
	registrarCreatedAtBlock: 31808582,
	l2Blocks: BASE_BLOCKS,
	gameFinalitySec: 5 * 86400,
};

// https://docs.linea.build/get-started/build/contracts
export const LINEA_MAINNET: LineaDeployment = {
	kind: "linea",
	l1: MAINNET,
	l2: LINEA,
	LineaRollup: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F",
	L2ReverseRegistrar: "0x0000000000D8e504002cC26E3Ec46D81971C1664",
	layout: PLAIN_LAYOUT,
	registrarCreatedAtBlock: 20173340,
};

export const OP_MAINNET_INBOX: InboxDeployment = {
	kind: "inbox",
	l1: MAINNET,
	l2: OPTIMISM,
	SystemConfig: "0x229047fed2591dbec1eF1118d64F7aF3dB9EB290",
	BatchInbox: "0xFF00000000000000000000000000000000000010",
	L2ReverseRegistrar: OP_MAINNET.L2ReverseRegistrar,
	layout: OP_MAINNET.layout,
	registrarCreatedAtBlock: OP_MAINNET.registrarCreatedAtBlock,
	l2Blocks: OP_MAINNET_BLOCKS,
};

export const BASE_MAINNET_INBOX: InboxDeployment = {
	kind: "inbox",
	l1: MAINNET,
	l2: BASE,
	SystemConfig: "0x73a79Fab69143498Ed3712e519A88a918e1f4072",
	BatchInbox: "0xFf00000000000000000000000000000000008453",
	L2ReverseRegistrar: BASE_MAINNET.L2ReverseRegistrar,
	layout: BASE_MAINNET.layout,
	registrarCreatedAtBlock: BASE_MAINNET.registrarCreatedAtBlock,
	l2Blocks: BASE_BLOCKS,
};

// https://docs.arbitrum.io/build-decentralized-apps/reference/contract-addresses
export const ARBITRUM_MAINNET: ArbitrumDeployment = {
	kind: "arbitrum",
	l1: MAINNET,
	l2: ARBITRUM,
	Rollup: "0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0",
	L2ReverseRegistrar: "0x0000000000D8e504002cC26E3Ec46D81971C1664",
	layout: PLAIN_LAYOUT, // no owner(); a name resolves at keccak(addr . 0) (test/ArbitrumVerifier.t.sol)
	registrarCreatedAtBlock: 349263357,
};

export const DEPLOYMENTS: Record<string, Deployment> = {
	optimism: OP_MAINNET,
	base: BASE_MAINNET,
	linea: LINEA_MAINNET,
	"optimism-inbox": OP_MAINNET_INBOX,
	"base-inbox": BASE_MAINNET_INBOX,
	arbitrum: ARBITRUM_MAINNET,
};

// ENSIP-19 coin type of an EVM chain: 0x80000000 | chainId (Ethereum mainnet keeps 60)
export function coinTypeFromChainId(chainId: number): bigint {
	if (chainId === 1) return 60n;
	if (!Number.isSafeInteger(chainId) || chainId < 0 || chainId >= 0x80000000) {
		throw new Error(`invalid chain id: ${chainId}`);
	}
	return 0x80000000n | BigInt(chainId);
}

// "default": general calls
// "logs": eth_getLogs over large ranges; not retried, the caller shrinks the range
// "proof": eth_getProof / linea_getProof at historical blocks (OP Stack lookback needs archive state)
// "public": the chain's public RPC only, never a key or an RPC_URL_<id> (which may hold one)
export type RPCPurpose = "default" | "logs" | "proof" | "public";

// Provider limits seen with our keys (2026-11-22):
//   drpc     wide getLogs (capped at 20000 results), proofs only ~100k blocks back
//   alchemy  archive proofs; free plan: getLogs over 10 blocks
//   infura   getLogs over 10000 blocks, proofs within 10000 blocks of the head, linea_getProof
const ORDER: Record<Exclude<RPCPurpose, "public">, ("drpc" | "alchemy" | "infura")[]> = {
	default: ["drpc", "infura", "alchemy"],
	logs: ["drpc", "infura", "alchemy"],
	proof: ["alchemy", "drpc", "infura"],
};

// PROOF_RPC_URL_<chainId> (proof only) > RPC_URL_<chainId> > DRPC_KEY / ALCHEMY_KEY / INFURA_KEY (by purpose) > public
export function rpcURL(chain: ChainInfo, purpose: RPCPurpose = "default"): string {
	if (purpose === "public") {
		if (!chain.publicRPC) throw new Error(`no public rpc for ${chain.name}`);
		return chain.publicRPC;
	}
	const env = process.env;
	const explicit = (purpose === "proof" && env[`PROOF_RPC_URL_${chain.id}`]) || env[`RPC_URL_${chain.id}`];
	if (explicit) return explicit;
	if (purpose === "logs" && chain.wideLogsRPC) return chain.wideLogsRPC;
	const urls = {
		drpc: env.DRPC_KEY && `https://lb.drpc.live/${chain.drpcSlug}/${env.DRPC_KEY}`,
		alchemy: env.ALCHEMY_KEY && `https://${chain.alchemySlug}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
		infura: env.INFURA_KEY && chain.infuraSlug && `https://${chain.infuraSlug}.infura.io/v3/${env.INFURA_KEY}`,
	};
	for (const provider of ORDER[purpose]) {
		const url = urls[provider];
		if (url) return url;
	}
	if (chain.publicRPC && chain.publicFallback !== false) return chain.publicRPC;
	throw new Error(`no rpc for ${chain.name}: set RPC_URL_${chain.id}, DRPC_KEY, ALCHEMY_KEY or INFURA_KEY`);
}

// BEACON_URL_<chainId> > public
export function beaconURL(chain: L1ChainInfo): string {
	const url = process.env[`BEACON_URL_${chain.id}`] ?? chain.publicBeacon;
	if (!url) throw new Error(`no beacon API for ${chain.name}: set BEACON_URL_${chain.id}`);
	return url;
}

export function createClient(chain: ChainInfo, purpose?: RPCPurpose): PublicClient {
	// an oversized log range fails the same way every time, slowly: the caller shrinks it instead
	const retry = purpose === "logs" ? { retryCount: 0, timeout: 30_000 } : { retryCount: 5, timeout: 60_000 };
	return createPublicClient({
		transport: http(rpcURL(chain, purpose), { batch: true, retryDelay: 500, ...retry }),
	});
}

// remove secrets from urls before logging
export function redactURL(url: string): string {
	return url.replace(/(\/v2\/|\/v3\/|drpc\.live\/[^/]+\/)[^/]+$/, "$1***");
}
