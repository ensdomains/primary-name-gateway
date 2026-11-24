// runtime-agnostic: no bun / node imports (usable from a Cloudflare Durable Object)
import { createFetchHandler, EZCCIP } from "@adraffy/ezccip";
import type { Commit, CommitKind } from "@primary-name-gateway/shared";
import type { Address } from "viem";
import type { RegistrarGateway } from "./gateway.js";
import { createRPCHandler } from "./rpc.js";

export { type GatewayConfig, type GatewayStats, RegistrarGateway, type SyncResult } from "./gateway.js";
export { createRPCHandler, type RPCConfig } from "./rpc.js";
export { MemoryNodeStore, type NodeStore, type SqlAdapter, SqlNodeStore } from "./store.js";

// CCIP-Read endpoint for L2ReverseResolver: proveName(address) returns (bytes), unsigned ("raw")
// served by createGatewayHandler() below (CCIP-Read on every path but /status and /rpc)
export function createEZCCIP(gateway: RegistrarGateway): EZCCIP {
	const ezccip = new EZCCIP({ protocol: "raw" });
	ezccip.addFunctionHandler("function proveName(address addr) returns (bytes)", async ([addr], _ctx, history) => {
		const { proof, commit } = gateway.proveName(addr);
		history.show = [addr, `${commit.kind}=${commit.id}`, `l2=${commit.l2Block}`];
		return [proof];
	});
	return ezccip;
}

// what a gateway serves: its chains, commit kind and registrar (the deployment's)
export type GatewayInfo = { kind: CommitKind; l1ChainId: number; l2ChainId: number; registrar: Address };

// GET /status: the deployment, the commit served to CCIP-Read and the held ones, the last sync, and the
// counters since `startedAt` (unix seconds)
export function gatewayStatus(gateway: RegistrarGateway, info: GatewayInfo, startedAt?: number) {
	const brief = ({ id, l2Block, validAt }: Commit) => ({ id, l2Block, validAt });
	const commits = gateway.commits;
	return {
		...info,
		served: commits.length ? brief(gateway.pick()) : undefined,
		held: commits.map(brief),
		lastSync: gateway.lastSync,
		startedAt,
		stats: gateway.stats,
		keepCommits: gateway.config.keepCommits,
		serveDelaySec: gateway.config.serveDelaySec ?? 0,
	};
}

// The gateway's HTTP side: GET /status, JSON-RPC for the registrar's storage at /rpc (rpc.ts), and
// CCIP-Read for L2ReverseResolver everywhere else. For Bun.serve, workers and Durable Objects.
export function createGatewayHandler(
	gateway: RegistrarGateway,
	info: GatewayInfo,
	options: { log?: boolean } = {},
): (request: Request) => Promise<Response> {
	const ccip = createFetchHandler(createEZCCIP(gateway), { log: options.log });
	const json = createRPCHandler(gateway, { chainId: info.l2ChainId, registrar: info.registrar });
	const startedAt = Math.floor(Date.now() / 1000);
	return async (request) => {
		const { pathname } = new URL(request.url);
		if (pathname === "/status") {
			return Response.json(gatewayStatus(gateway, info, startedAt), {
				headers: { "access-control-allow-origin": "*" },
			});
		}
		return pathname === "/rpc" ? json(request) : ccip(request);
	};
}
