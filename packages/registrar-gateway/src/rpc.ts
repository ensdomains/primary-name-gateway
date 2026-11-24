// JSON-RPC for the registrar's storage at the blocks of the commits the gateway holds, answered from
// its rows as an L2 node would: eth_getProof (Merkle-Patricia commits; identical to an archive node's,
// checked against Alchemy on Arbitrum and Base) and eth_getStorageAt, plus eth_chainId and
// eth_blockNumber for tooling. Runtime-agnostic, like index.ts. See docs/gateway-rpc.md.

import { chunkReader, proveLineaSlots, proveSlot } from "@primary-name-gateway/shared";
import {
	type Address,
	bytesToHex,
	decodeAbiParameters,
	fromRlp,
	type Hex,
	hexToBigInt,
	hexToBytes,
	isAddress,
	isHex,
	numberToHex,
	padHex,
} from "viem";
import type { RegistrarGateway } from "./gateway.js";

type RPCRequest = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type Reply = { jsonrpc: "2.0"; id: unknown } & ({ result: unknown } | { error: { code: number; message: string } });

class RPCError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

const CORS = { "access-control-allow-origin": "*" };

// the L2's chain id and the registrar (the only account served) come from the gateway's indexer
export function createRPCHandler(gateway: RegistrarGateway): (request: Request) => Promise<Response> {
	const info = () => {
		const i = gateway.info;
		if (!i) throw new RPCError(-32000, "no commit yet");
		return i;
	};
	const methods: Record<string, (params: unknown[]) => unknown> = {
		eth_chainId: () => numberToHex(info().l2ChainId),
		eth_blockNumber: () => numberToHex(servedCommit(gateway).l2Block),
		eth_getStorageAt: ([address, slot, block]) => {
			const commit = commitAt(gateway, block);
			checkAddress(address, info().registrar);
			return padHex(bytesToHex(readSlots(gateway, commit, [slotBytes(slot)])[0].value), { size: 32 });
		},
		eth_getProof: ([address, keys, block]) => {
			const commit = commitAt(gateway, block);
			const { registrar } = info();
			checkAddress(address, registrar);
			if (!Array.isArray(keys)) throw new RPCError(-32602, "storage keys: expected an array");
			if (commit.kind === "linea") {
				throw new RPCError(-32601, "eth_getProof: Linea's state isn't a Merkle-Patricia trie (linea_getProof)");
			}
			const [accountProof] = decodeAbiParameters([{ type: "bytes[]" }], commit.accountProof);
			// the registrar's account: the last node is its leaf, [path, rlp([nonce, balance, storageRoot, codeHash])]
			const leaf = fromRlp(accountProof[accountProof.length - 1]) as Hex[];
			const [nonce, balance, storageHash, codeHash] = fromRlp(leaf[1]) as Hex[];
			const proofs = readSlots(gateway, commit, keys.map(slotBytes));
			return {
				address: registrar.toLowerCase(), // as nodes answer it
				balance: quantity(balance),
				codeHash,
				nonce: quantity(nonce),
				storageHash,
				accountProof,
				storageProof: keys.map((key, i) => ({
					key,
					value: quantity(bytesToHex(proofs[i].value)),
					proof: proofs[i].proof,
				})),
			};
		},
	};

	const answer = async (req: RPCRequest): Promise<Reply> => {
		const id = req?.id ?? null;
		try {
			if (req?.jsonrpc !== "2.0" || typeof req.method !== "string") throw new RPCError(-32600, "invalid request");
			const method = methods[req.method];
			if (!method) {
				throw new RPCError(-32601, `method not found: ${req.method} (served: ${Object.keys(methods).join(", ")})`);
			}
			return { jsonrpc: "2.0", id, result: method(Array.isArray(req.params) ? req.params : []) };
		} catch (err) {
			const error =
				err instanceof RPCError
					? { code: err.code, message: err.message }
					: { code: -32603, message: err instanceof Error ? err.message : String(err) };
			return { jsonrpc: "2.0", id, error };
		}
	};

	return async (request: Request) => {
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: { ...CORS, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "*" },
			});
		}
		if (request.method !== "POST") return new Response("JSON-RPC: POST only", { status: 405, headers: CORS });
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
				{ headers: CORS },
			);
		}
		if (Array.isArray(body)) {
			if (!body.length) {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "empty batch" } },
					{ headers: CORS },
				);
			}
			return Response.json(await Promise.all(body.map(answer)), { headers: CORS });
		}
		return Response.json(await answer(body as RPCRequest), { headers: CORS });
	};
}

// the commit the gateway serves (its "latest")
function servedCommit(gateway: RegistrarGateway) {
	if (!gateway.commits.length) throw new RPCError(-32000, "no commit yet");
	return gateway.pick();
}

// A held commit's block, or the served one for a tag. Only those blocks have rows: another block is an
// error, never a nearby block's answer.
function commitAt(gateway: RegistrarGateway, block: unknown) {
	if (block === undefined || block === "latest" || block === "safe" || block === "finalized" || block === "pending") {
		return servedCommit(gateway);
	}
	const number =
		typeof block === "object" && block && "blockNumber" in block
			? (block as { blockNumber: unknown }).blockNumber
			: block;
	if (typeof number !== "string" || !isHex(number)) {
		throw new RPCError(-32602, `block: a number or latest (blocks by hash aren't served)`);
	}
	const n = Number(hexToBigInt(number));
	const commit = gateway.commits.find((c) => c.l2Block === n);
	if (!commit) {
		const held = gateway.commits.map((c) => c.l2Block).join(", ");
		throw new RPCError(-32000, `block ${n} isn't available: the gateway holds L2 blocks ${held || "none yet"}`);
	}
	return commit;
}

function checkAddress(address: unknown, registrar: Address) {
	if (typeof address !== "string" || !isAddress(address, { strict: false })) {
		throw new RPCError(-32602, "address: expected an address");
	}
	if (address.toLowerCase() !== registrar.toLowerCase()) {
		throw new RPCError(-32000, `only the registrar ${registrar} is served`);
	}
}

function slotBytes(slot: unknown): Uint8Array {
	if (typeof slot !== "string" || !isHex(slot) || slot.length > 66) {
		throw new RPCError(-32602, "storage key: expected up to 32 bytes of hex");
	}
	return hexToBytes(padHex(slot, { size: 32 }));
}

// values (and Merkle-Patricia proofs) of slots at a commit's version, from the rows
function readSlots(gateway: RegistrarGateway, commit: ReturnType<typeof servedCommit>, slots: Uint8Array[]) {
	const version = commit.l2Block;
	const get = (path: string) => gateway.store.get(path, version);
	if (commit.kind === "linea") {
		const floor = (prefix: string, before: string) => gateway.store.floor(prefix, before, version);
		return proveLineaSlots(get, floor, slots).values.map((value) => ({ value, proof: [] as Hex[] }));
	}
	const read = chunkReader(get); // each chunk read once for all the slots
	return slots.map((slot) => proveSlot(read, slot));
}

// RLP bytes as a JSON-RPC quantity
function quantity(bytes: Hex): Hex {
	return numberToHex(bytes === "0x" ? 0n : hexToBigInt(bytes));
}
