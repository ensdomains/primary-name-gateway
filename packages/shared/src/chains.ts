import { type Address, createPublicClient, http, type PublicClient } from "viem";
import { PLAIN_LAYOUT, type RegistrarLayout } from "./registrar.js";

export type ChainInfo = {
	id: number;
	name: string;
	drpcSlug: string;
	alchemySlug: string;
	publicRPC?: string;
	logStep?: number; // eth_getLogs block range
};

export const MAINNET: ChainInfo = {
	id: 1,
	name: "mainnet",
	drpcSlug: "ethereum",
	alchemySlug: "eth-mainnet",
	publicRPC: "https://ethereum-rpc.publicnode.com",
};

export const OPTIMISM: ChainInfo = {
	id: 10,
	name: "optimism",
	drpcSlug: "optimism",
	alchemySlug: "opt-mainnet",
	publicRPC: "https://mainnet.optimism.io",
	logStep: 500000, // shrinks automatically if the provider refuses
};

export const LINEA: ChainInfo = {
	id: 59144,
	name: "linea",
	drpcSlug: "linea",
	alchemySlug: "linea-mainnet",
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
	linea: LINEA_MAINNET,
};

// ENSIP-11 coin type of an EVM chain
export function evmCoinType(chainId: number): number {
	return (0x80000000 | chainId) >>> 0;
}

// "default": general calls and eth_getLogs (drpc allows large log ranges)
// "proof": eth_getProof at historical blocks (needs archive state: alchemy)
export type RPCPurpose = "default" | "proof";

// PROOF_RPC_URL_<chainId> (proof only) > RPC_URL_<chainId> > DRPC_KEY / ALCHEMY_KEY > public
export function rpcURL(chain: ChainInfo, purpose: RPCPurpose = "default"): string {
	const env = process.env;
	const explicit = (purpose === "proof" && env[`PROOF_RPC_URL_${chain.id}`]) || env[`RPC_URL_${chain.id}`];
	if (explicit) return explicit;
	const drpc = env.DRPC_KEY && `https://lb.drpc.live/${chain.drpcSlug}/${env.DRPC_KEY}`;
	const alchemy = env.ALCHEMY_KEY && `https://${chain.alchemySlug}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
	const url = purpose === "proof" ? alchemy || drpc : drpc || alchemy;
	if (url) return url;
	if (chain.publicRPC) return chain.publicRPC;
	throw new Error(`no rpc for ${chain.name}: set RPC_URL_${chain.id}, DRPC_KEY, or ALCHEMY_KEY`);
}

export function createClient(chain: ChainInfo, purpose?: RPCPurpose): PublicClient {
	return createPublicClient({
		transport: http(rpcURL(chain, purpose), { batch: true, retryCount: 5, retryDelay: 500, timeout: 60_000 }),
	});
}

// remove secrets from urls before logging
export function redactURL(url: string): string {
	return url.replace(/(\/v2\/|drpc\.live\/[^/]+\/)[^/]+$/, "$1***");
}
