// rpcURL (shared/chains.ts): which URL each purpose gets from the environment, and "public", which
// never uses a key.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ARBITRUM_MAINNET, BASE_MAINNET, OP_MAINNET, rpcURL } from "@primary-name-gateway/shared";

const VARS = ["DRPC_KEY", "ALCHEMY_KEY", "INFURA_KEY", "RPC_URL_10", "PROOF_RPC_URL_10"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
	for (const k of VARS) delete process.env[k];
});
afterEach(() => {
	for (const k of VARS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const op = OP_MAINNET.l2;

test("keys by purpose, explicit URLs first, the public RPC last", () => {
	expect(rpcURL(op)).toBe(op.publicRPC!);
	process.env.INFURA_KEY = "i";
	process.env.ALCHEMY_KEY = "a";
	expect(rpcURL(op)).toContain("infura.io/v3/i");
	expect(rpcURL(op, "proof")).toContain("alchemy.com/v2/a");
	process.env.RPC_URL_10 = "http://explicit";
	process.env.PROOF_RPC_URL_10 = "http://archive";
	expect(rpcURL(op)).toBe("http://explicit");
	expect(rpcURL(op, "proof")).toBe("http://archive");
	expect(rpcURL(ARBITRUM_MAINNET.l2, "logs")).toBe(ARBITRUM_MAINNET.l2.wideLogsRPC!);
});

test("public: the chain's public RPC whatever is set, or an error", () => {
	process.env.DRPC_KEY = "d";
	process.env.RPC_URL_10 = "http://explicit";
	expect(rpcURL(op, "public")).toBe(op.publicRPC!);
	expect(() => rpcURL(BASE_MAINNET.l2, "public")).toThrow("no public rpc for base");
});
