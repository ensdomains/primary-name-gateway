// runtime-agnostic: no bun / node imports (usable from a Cloudflare Durable Object)
import { createFetchHandler, EZCCIP } from "@adraffy/ezccip";
import type { RegistrarGateway } from "./gateway.js";
import { createRPCHandler, type RPCConfig } from "./rpc.js";

export { type GatewayConfig, type GatewayStats, RegistrarGateway } from "./gateway.js";
export { createRPCHandler, type RPCConfig } from "./rpc.js";
export { MemoryNodeStore, type NodeStore, type SqlAdapter, SqlNodeStore } from "./store.js";

// CCIP-Read endpoint for L2ReverseResolver: proveName(address) returns (bytes), unsigned ("raw")
// serve with serveEZCCIP() (bun/node) or createFetchHandler() (workers, Durable Objects)
export function createEZCCIP(gateway: RegistrarGateway): EZCCIP {
	const ezccip = new EZCCIP({ protocol: "raw" });
	ezccip.addFunctionHandler("function proveName(address addr) returns (bytes)", async ([addr], _ctx, history) => {
		const { proof, commit } = gateway.proveName(addr);
		history.show = [addr, `${commit.kind}=${commit.id}`, `l2=${commit.l2Block}`];
		return [proof];
	});
	return ezccip;
}

// The gateway's HTTP side: JSON-RPC for the registrar's storage at /rpc (rpc.ts), and CCIP-Read for
// L2ReverseResolver everywhere else. For Bun.serve, workers and Durable Objects.
export function createGatewayHandler(
	gateway: RegistrarGateway,
	rpc: RPCConfig,
	options: { log?: boolean } = {},
): (request: Request) => Promise<Response> {
	const ccip = createFetchHandler(createEZCCIP(gateway), { log: options.log });
	const json = createRPCHandler(gateway, rpc);
	return async (request) => {
		const { pathname } = new URL(request.url);
		return pathname === "/rpc" ? json(request) : ccip(request);
	};
}
