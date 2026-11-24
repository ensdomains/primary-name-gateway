// runtime-agnostic: no bun / node imports (usable from a Cloudflare Durable Object)
import { createFetchHandler, EZCCIP } from "@adraffy/ezccip";
import type { Commit } from "@primary-name-gateway/shared";
import type { RegistrarGateway } from "./gateway.js";
import { createRPCHandler } from "./rpc.js";

export {
	type GatewayConfig,
	type GatewayInfo,
	type GatewayStats,
	RegistrarGateway,
	type SyncResult,
} from "./gateway.js";
export { createRPCHandler } from "./rpc.js";
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

// GET /status: the deployment (from the indexer; absent until it has answered), the commit served to
// CCIP-Read and the held ones, the last sync, and the counters since `startedAt` (unix seconds)
export function gatewayStatus(gateway: RegistrarGateway, startedAt?: number) {
	const brief = ({ id, l2Block, validAt }: Commit) => ({ id, l2Block, validAt });
	const commits = gateway.commits;
	return {
		...gateway.info,
		indexerURL: gateway.config.indexerURL,
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
	options: { log?: boolean } = {},
): (request: Request) => Promise<Response> {
	const ccip = createFetchHandler(createEZCCIP(gateway), { log: options.log });
	const json = createRPCHandler(gateway);
	const startedAt = Math.floor(Date.now() / 1000);
	return async (request) => {
		const { pathname } = new URL(request.url);
		if (pathname === "/status") {
			return Response.json(gatewayStatus(gateway, startedAt), {
				headers: { "access-control-allow-origin": "*" },
			});
		}
		return pathname === "/rpc" ? json(request) : ccip(request);
	};
}
