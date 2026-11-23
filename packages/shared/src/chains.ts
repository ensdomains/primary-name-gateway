import { type Address, createPublicClient, http, type PublicClient } from "viem";
import { OWNABLE_LAYOUT, PLAIN_LAYOUT, type RegistrarLayout } from "./registrar.js";

export type ChainInfo = {
	id: number;
	name: string;
	drpcSlug: string;
	alchemySlug: string;
	infuraSlug?: string;
	publicRPC?: string;
	logStep?: number; // eth_getLogs block range
};

export const MAINNET: ChainInfo = {
	id: 1,
	name: "mainnet",
	drpcSlug: "ethereum",
	alchemySlug: "eth-mainnet",
	infuraSlug: "mainnet",
	publicRPC: "https://ethereum-rpc.publicnode.com",
};

export const OPTIMISM: ChainInfo = {
	id: 10,
	name: "optimism",
	drpcSlug: "optimism",
	alchemySlug: "opt-mainnet",
	infuraSlug: "optimism-mainnet",
	publicRPC: "https://mainnet.optimism.io",
	logStep: 500000, // shrinks automatically if the provider refuses
};

export const BASE: ChainInfo = {
	id: 8453,
	name: "base",
	drpcSlug: "base",
	alchemySlug: "base-mainnet",
	infuraSlug: "base-mainnet",
	// no publicRPC: mainnet.base.org rate limits eth_getLogs
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

type DeploymentBase = {
	l1: ChainInfo;
	l2: ChainInfo;
	L2ReverseRegistrar: Address;
	layout: RegistrarLayout; // see docs/registrar.md
	registrarCreatedAtBlock: number; // first L2 block to scan for events
};

// an L2 whose state is committed to L1 via OP dispute games (Merkle-Patricia tries)
export type OPDeployment = DeploymentBase & {
	kind: "op";
	AnchorStateRegistry: Address;
	l2BlockTime: number; // seconds
	gameFinalitySec: number; // typical time from game creation to isGameClaimValid (sets indexer defaults)
};

// Linea: finalized (ZK proven) state roots on L1 (sparse Merkle tries, linea_getProof)
export type LineaDeployment = DeploymentBase & {
	kind: "linea";
	LineaRollup: Address;
};

export type Deployment = OPDeployment | LineaDeployment;

// https://docs.optimism.io/chain/addresses
// https://docs.ens.domains/ensip/19/#annex-supported-chains
export const OP_MAINNET: OPDeployment = {
	kind: "op",
	l1: MAINNET,
	l2: OPTIMISM,
	AnchorStateRegistry: "0x23B2C62946350F4246f9f9D027e071f0264FD113",
	L2ReverseRegistrar: "0x0000000000D8e504002cC26E3Ec46D81971C1664",
	layout: PLAIN_LAYOUT,
	registrarCreatedAtBlock: 137403854,
	l2BlockTime: 2,
	gameFinalitySec: 7 * 86400, // 3.5d clock + 3.5d airgap
};

// Base: output root games of type 621 (AggregateVerifier: TEE + ZK multiproofs), valid after ~5 days.
// https://github.com/base/contracts/blob/main/src/L1/proofs/AggregateVerifier.sol
export const BASE_MAINNET: OPDeployment = {
	kind: "op",
	l1: MAINNET,
	l2: BASE,
	AnchorStateRegistry: "0x909f6cf47ed12f010A796527f562bFc26C7F4E72",
	L2ReverseRegistrar: "0x0000000000D8e504002cC26E3Ec46D81971C1664",
	layout: OWNABLE_LAYOUT, // L2ReverseRegistrarWithMigration
	registrarCreatedAtBlock: 31808582,
	l2BlockTime: 2,
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

export const DEPLOYMENTS: Record<string, Deployment> = {
	optimism: OP_MAINNET,
	base: BASE_MAINNET,
	linea: LINEA_MAINNET,
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
// "logs": eth_getLogs over large ranges; retried once, the caller shrinks the range
// "proof": eth_getProof / linea_getProof at historical blocks (OP Stack lookback needs archive state)
export type RPCPurpose = "default" | "logs" | "proof";

// Provider limits seen with our keys (2026-11-22):
//   drpc     wide getLogs (capped at 20000 results), proofs only ~100k blocks back
//   alchemy  archive proofs; free plan: getLogs over 10 blocks
//   infura   getLogs over 10000 blocks, proofs within 10000 blocks of the head, linea_getProof
const ORDER: Record<RPCPurpose, ("drpc" | "alchemy" | "infura")[]> = {
	default: ["drpc", "infura", "alchemy"],
	logs: ["drpc", "infura", "alchemy"],
	proof: ["alchemy", "drpc", "infura"],
};

// PROOF_RPC_URL_<chainId> (proof only) > RPC_URL_<chainId> > DRPC_KEY / ALCHEMY_KEY / INFURA_KEY (by purpose) > public
export function rpcURL(chain: ChainInfo, purpose: RPCPurpose = "default"): string {
	const env = process.env;
	const explicit = (purpose === "proof" && env[`PROOF_RPC_URL_${chain.id}`]) || env[`RPC_URL_${chain.id}`];
	if (explicit) return explicit;
	const urls = {
		drpc: env.DRPC_KEY && `https://lb.drpc.live/${chain.drpcSlug}/${env.DRPC_KEY}`,
		alchemy: env.ALCHEMY_KEY && `https://${chain.alchemySlug}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
		infura: env.INFURA_KEY && chain.infuraSlug && `https://${chain.infuraSlug}.infura.io/v3/${env.INFURA_KEY}`,
	};
	for (const provider of ORDER[purpose]) {
		const url = urls[provider];
		if (url) return url;
	}
	if (chain.publicRPC) return chain.publicRPC;
	throw new Error(`no rpc for ${chain.name}: set RPC_URL_${chain.id}, DRPC_KEY, ALCHEMY_KEY or INFURA_KEY`);
}

export function createClient(chain: ChainInfo, purpose?: RPCPurpose): PublicClient {
	// an oversized log range fails the same way every time: let the caller shrink it instead of retrying
	const retry = purpose === "logs" ? { retryCount: 1, timeout: 30_000 } : { retryCount: 5, timeout: 60_000 };
	return createPublicClient({
		transport: http(rpcURL(chain, purpose), { batch: true, retryDelay: 500, ...retry }),
	});
}

// remove secrets from urls before logging
export function redactURL(url: string): string {
	return url.replace(/(\/v2\/|\/v3\/|drpc\.live\/[^/]+\/)[^/]+$/, "$1***");
}
