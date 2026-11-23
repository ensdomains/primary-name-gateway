// runtime-agnostic: no bun / node imports (usable from a Cloudflare Durable Object)
import { EZCCIP } from "@adraffy/ezccip";
import type { Hex } from "viem";
import type { RegistrarGateway } from "./gateway.js";

export { type GatewayConfig, type GatewayStats, RegistrarGateway } from "./gateway.js";
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
