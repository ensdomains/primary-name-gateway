// runtime-agnostic: no bun / node imports (usable from a Cloudflare Durable Object)
import { EZCCIP } from "@namestone/ezccip";
import type { Hex } from "viem";
import type { RegistrarGateway } from "./gateway.js";

export { encodeOPFaultCommitProof, type GatewayConfig, type GatewayStats, RegistrarGateway } from "./gateway.js";
export { MemoryNodeStore, type NodeStore, type SqlAdapter, SqlNodeStore } from "./store.js";

// CCIP-Read endpoint for L2ReverseResolver: proveName(address) returns (bytes)
// serve with ezccip's serve() (bun/node) or ezccip.handleRead(sender, data, { protocol: "raw" }) (workers)
export function createEZCCIP(gateway: RegistrarGateway): EZCCIP {
	const ezccip = new EZCCIP();
	ezccip.register("proveName(address) returns (bytes)", async ([addr], _context, history) => {
		const { proof, commit } = gateway.proveName(addr as Hex);
		history.show = [addr, `game=${commit.gameIndex}`, `l2=${commit.l2Block}`];
		return [proof];
	});
	return ezccip;
}
