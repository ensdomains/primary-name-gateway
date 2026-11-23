// End-to-end: anvil fork of L1 mainnet + live registrar-indexer + in-process registrar-gateway.
//
// 1. `bun run indexer` (needs at least one valid commit: ~7 days of lookback, archive proof RPC)
// 2. `bun run forge`
// 3. `bun test test/e2e.test.ts`
//
// Deploys OPFaultVerifier + L2ReverseResolver on the fork, then resolves every known OP primary name
// through CCIP-Read and compares against the L2ReverseRegistrar at the same L2 block.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Change, createClient, OP_MAINNET, rpcURL } from "@primary-name-gateway/shared";
import { serve } from "@namestone/ezccip/serve";
import {
	type Abi,
	type Address,
	createPublicClient,
	createWalletClient,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	http,
	namehash,
	parseAbi,
	type PublicClient,
	toHex,
	type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { createEZCCIP, MemoryNodeStore, RegistrarGateway } from "../packages/registrar-gateway/src/index.js";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:8100";
const COIN_TYPE = (0x80000000 | OP_MAINNET.l2.id) >>> 0;
const ANVIL_PORT = 8545 + Math.floor(Math.random() * 1000);
// anvil's default account #0 (test key, local fork only)
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const RESOLVER_ABI = parseAbi([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function verifyName(address addr, bytes proof) view returns (string)",
	"function name(bytes32) view returns (string)",
]);
const L2_REGISTRAR_ABI = parseAbi(["function nameForAddr(address) view returns (string)"]);

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
	const json = require(`../packages/contracts/out/${file}/${name}.json`);
	return { abi: json.abi, bytecode: json.bytecode.object };
}

async function indexerHasValidCommit(): Promise<boolean> {
	try {
		const res = await fetch(`${INDEXER_URL}/commits?status=valid&limit=1`);
		return res.ok && ((await res.json()) as unknown[]).length > 0;
	} catch {
		return false;
	}
}

const ready = await indexerHasValidCommit();
if (!ready) console.warn(`skipping e2e: no valid commits at ${INDEXER_URL}`);

describe.skipIf(!ready)("e2e", () => {
	let anvil: Bun.Subprocess;
	let ccip: Awaited<ReturnType<typeof serve>>;
	let gateway: RegistrarGateway;
	let l1: PublicClient;
	let wallet: WalletClient;
	let resolver: Address;
	let names: Map<Address, Hex>; // latest name per address at the served commit

	beforeAll(async () => {
		gateway = new RegistrarGateway(new MemoryNodeStore(), { indexerURL: INDEXER_URL, keep: 2, marginSec: 0 });
		await gateway.sync();
		ccip = await serve(createEZCCIP(gateway), { protocol: "raw", log: false });

		anvil = Bun.spawn(["anvil", "--fork-url", rpcURL(OP_MAINNET.l1), "--port", String(ANVIL_PORT), "--silent"], {
			stdout: "ignore",
			stderr: "inherit",
		});
		const transport = http(`http://127.0.0.1:${ANVIL_PORT}`);
		l1 = createPublicClient({ transport });
		wallet = createWalletClient({ transport, account: DEPLOYER });
		for (let i = 0; ; i++) {
			try {
				await l1.getBlockNumber();
				break;
			} catch {
				if (i > 100) throw new Error("anvil did not start");
				await Bun.sleep(100);
			}
		}

		const deploy = async (a: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
			const hash = await wallet.deployContract({ ...a, args, account: DEPLOYER, chain: null });
			const receipt = await l1.waitForTransactionReceipt({ hash });
			return receipt.contractAddress!;
		};
		const verifier = await deploy(artifact("OPFaultVerifier.sol", "OPFaultVerifier"), [
			OP_MAINNET.AnchorStateRegistry,
			OP_MAINNET.l2.id,
			86400, // window: 1 day of L2 timestamps
		]);
		resolver = await deploy(artifact("L2ReverseResolver.sol", "L2ReverseResolver"), [
			verifier,
			OP_MAINNET.L2ReverseRegistrar,
			COIN_TYPE,
			[ccip.endpoint],
		]);

		// replay the change log up to the commit the gateway serves
		const { commit } = gateway.proveName("0x0000000000000000000000000000000000000000");
		const changes = (await fetch(`${INDEXER_URL}/changes?until=${commit.changeSeq}`).then((r) => r.json())) as Change[];
		names = new Map(changes.map((c) => [c.addr.toLowerCase() as Address, c.name]));
		console.log(`commit: game ${commit.gameIndex}, L2 block ${commit.l2Block}, ${names.size} addresses`);
	}, 60_000);

	afterAll(async () => {
		await ccip?.shutdown();
		anvil?.kill();
	});

	async function resolveName(addr: Address): Promise<string> {
		const name = `${addr.slice(2).toLowerCase()}.${COIN_TYPE.toString(16)}.reverse`;
		const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: "name", args: [namehash(name)] });
		const result = await l1.readContract({
			address: resolver,
			abi: RESOLVER_ABI,
			functionName: "resolve",
			args: [toHex(packetToBytes(name)), data], // ccip-read is handled by viem
		});
		return decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "name", data: result });
	}

	test("resolve() via CCIP-Read matches L2ReverseRegistrar at the commit block", async () => {
		const { commit } = gateway.proveName("0x0000000000000000000000000000000000000000");
		const l2 = createClient(OP_MAINNET.l2, "proof");
		const sample = [...names.keys()].slice(0, 5);
		for (const addr of sample) {
			const [actual, expected] = await Promise.all([
				resolveName(addr),
				l2.readContract({
					address: OP_MAINNET.L2ReverseRegistrar,
					abi: L2_REGISTRAR_ABI,
					functionName: "nameForAddr",
					args: [addr],
					blockNumber: BigInt(commit.l2Block),
				}),
			]);
			expect(actual).toBe(expected);
		}
	}, 60_000);

	test("every indexed address verifies", async () => {
		const decoder = new TextDecoder();
		let long = 0;
		for (const [addr, name] of names) {
			const { proof } = gateway.proveName(addr);
			const actual = await l1.readContract({
				address: resolver,
				abi: RESOLVER_ABI,
				functionName: "verifyName",
				args: [addr, proof],
			});
			expect(actual).toBe(decoder.decode(Buffer.from(name.slice(2), "hex")));
			if ((name.length - 2) / 2 >= 32) long++;
		}
		console.log(`verified ${names.size} names (${long} long)`);
	}, 300_000);

	test("address without a name resolves to empty", async () => {
		expect(await resolveName("0x000000000000000000000000000000000000beef")).toBe("");
	}, 30_000);

	test("tampered proof is rejected", async () => {
		const [addr] = names.keys();
		const { proof } = gateway.proveName(addr);
		const other = "0x000000000000000000000000000000000000beef";
		// a valid proof for addr does not prove a name for another address
		expect(
			l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [other, proof] }),
		).rejects.toThrow();
		// flip a byte inside the proof
		const i = proof.length - 200;
		const flipped = `${proof.slice(0, i)}${proof[i] === "0" ? "1" : "0"}${proof.slice(i + 1)}` as Hex;
		expect(
			l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [addr, flipped] }),
		).rejects.toThrow();
	}, 30_000);
});
