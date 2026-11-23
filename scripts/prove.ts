// Prove one address's primary name through a gateway, end to end on an L1 fork: deploys the chain's
// verifier and an L2ReverseResolver that points at the gateway, resolves `{addr}.{coinType}.reverse`
// with CCIP-Read as a client would, and compares the result with the L2 registrar at the proof's block.
// Only the gateway (and RPC) is contacted: the proof itself says which L2 block it is for.
//
//   bun run prove <address> <chain> [--gateway URL] [--min-age SEC]
//
// chain: a deployment (base, base-inbox, optimism, linea, ...); the gateway defaults to the port of
// `bun run gateway:<chain>`. --min-age: the verifier's minAgeSec for OP Stack fault proofs, as the
// indexer's INDEXER_MIN_AGE_SEC (default: that variable, or 0). Needs .env RPC keys.

import { Foundry } from "@adraffy/blocksmith";
import {
	coinTypeFromChainId,
	createClient,
	DEPLOYMENTS,
	type Deployment,
	decodeOPBatchInboxCommitProof,
	decodeOPFaultCommitProof,
	rpcURL,
} from "@primary-name-gateway/shared";
import {
	type Address,
	BaseError,
	ccipRequest,
	createPublicClient,
	decodeAbiParameters,
	decodeFunctionResult,
	encodeFunctionData,
	fromRlp,
	getAddress,
	type Hex,
	hexToBigInt,
	http,
	isAddress,
	namehash,
	parseAbi,
	toHex,
} from "viem";
import { packetToBytes } from "viem/ens";
import { verifierContract } from "./verifiers.js";

// the ports of the package.json gateway scripts
const GATEWAY_PORTS: Record<string, number> = { optimism: 8200, linea: 8201, base: 8202, "base-inbox": 8203 };

const RESOLVER_ABI = parseAbi([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function verifyName(address addr, bytes proof) view returns (string)",
	"function name(bytes32) view returns (string)",
]);
const L2_REGISTRAR_ABI = parseAbi(["function nameForAddr(address) view returns (string)"]);
const NAME_PROOF = {
	type: "tuple",
	components: [
		{ name: "commitProof", type: "bytes" },
		{ name: "accountProof", type: "bytes" },
		{ name: "dataSlots", type: "uint256" },
		{ name: "storageProof", type: "bytes" },
	],
} as const;

function usage(message?: string): never {
	if (message) console.error(message);
	console.error(
		`usage: bun run prove <address> <${Object.keys(DEPLOYMENTS).join(" | ")}> [--gateway URL] [--min-age SEC]`,
	);
	process.exit(1);
}

function parseArgs() {
	const args = process.argv.slice(2);
	let gateway = process.env.GATEWAY_URL;
	let minAge = process.env.INDEXER_MIN_AGE_SEC;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--gateway") gateway = args[++i];
		else if (args[i] === "--min-age") minAge = args[++i];
		else rest.push(args[i]);
	}
	const [addr, chain] = rest;
	if (!addr || !isAddress(addr)) usage(addr && `not an address: ${addr}`);
	const d = (chain && DEPLOYMENTS[chain]) || usage(chain ? `unknown chain: ${chain}` : "which chain?");
	const port = GATEWAY_PORTS[chain];
	gateway ??= port ? `http://localhost:${port}` : usage(`no default gateway for ${chain}: pass --gateway`);
	const minAgeSec = Number(minAge ?? 0);
	if (!Number.isInteger(minAgeSec) || minAgeSec < 0) usage(`not a number of seconds: ${minAge}`);
	return { addr: getAddress(addr), chain, d, gateway, minAgeSec };
}

const n = (x: number | bigint) => x.toLocaleString("en-US");
const ms = (x: number) => (x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);
function duration(sec: number): string {
	if (sec < 120) return `${sec}s`;
	const m = Math.round(sec / 60);
	if (m < 120) return `${m}m`;
	const h = Math.round(m / 60);
	return h < 48
		? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
		: `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

// the L2 block a commit proof is for, and what names the commit
async function proofBlock(d: Deployment, commitProof: Hex): Promise<{ block: number; commit: string }> {
	switch (d.kind) {
		case "op": {
			const { game, outputRootProof } = decodeOPFaultCommitProof(commitProof);
			const block = await createClient(d.l2).getBlock({ blockHash: outputRootProof.latestBlockhash });
			return { block: Number(block.number), commit: `game ${game}` };
		}
		case "inbox": {
			const p = decodeOPBatchInboxCommitProof(commitProof);
			const number = (h: Hex) => Number(hexToBigInt((fromRlp(h) as Hex[])[8]));
			return { block: number(p.l2Header), commit: `batch in L1 block ${n(number(p.l1Header))}` };
		}
		case "linea": {
			const [block] = decodeAbiParameters([{ type: "uint256" }], commitProof);
			return { block: Number(block), commit: "finalization" };
		}
	}
}

const { addr, chain, d, gateway, minAgeSec } = parseArgs();
const blockMs = "l2Blocks" in d ? `, ${d.l2Blocks[d.l2Blocks.length - 1].ms} ms blocks` : "";
const early = minAgeSec ? `, games accepted unchallenged after ${minAgeSec}s` : "";
console.log(`${chain} (${d.kind}, L1 ${d.l1.id} → L2 ${d.l2.id}${blockMs}${early}): gateway ${gateway}`);

const started = Date.now();
const foundry = await Foundry.launch({
	root: `${import.meta.dir}/../packages/contracts`,
	fork: rpcURL(d.l1),
	infoLog: false,
});
try {
	let response: Hex | undefined;
	let gatewayMs = 0;
	const l1 = createPublicClient({
		transport: http(`http://127.0.0.1:${foundry.port}`),
		ccipRead: {
			// the gateway call, timed
			async request(params) {
				const t0 = performance.now();
				response = await ccipRequest(params).catch((err: BaseError) => {
					throw new Error(`gateway ${params.urls.join(", ")}: ${err.details ?? err.shortMessage} (is it running?)`);
				});
				gatewayMs = performance.now() - t0;
				return response;
			},
		},
	});
	const forkBlock = await l1.getBlockNumber();
	const { contract, args } = verifierContract(d, minAgeSec);
	const verifier = await foundry.deploy({ file: contract, args });
	const coinType = coinTypeFromChainId(d.l2.id);
	const resolver = await foundry.deploy({
		file: "L2ReverseResolver",
		args: [verifier.target, d.L2ReverseRegistrar, d.layout.namesSlot, coinType, [gateway]],
	});
	console.log(
		`L1 fork at block ${n(forkBlock)}: ${contract} ${verifier.target}, L2ReverseResolver ${resolver.target} (${ms(Date.now() - started)})\n`,
	);

	// ENSIP-19 reverse name, resolved as a client would (viem follows the OffchainLookup)
	const name = `${addr.slice(2).toLowerCase()}.${coinType.toString(16)}.reverse`;
	const call = encodeFunctionData({ abi: RESOLVER_ABI, functionName: "name", args: [namehash(name)] });
	const result = await l1.readContract({
		address: resolver.target as Address,
		abi: RESOLVER_ABI,
		functionName: "resolve",
		args: [toHex(packetToBytes(name)), call],
	});
	const primary = decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "name", data: result });
	const [proof] = decodeAbiParameters([{ type: "bytes" }], response!);
	const gas = await l1.estimateContractGas({
		address: resolver.target as Address,
		abi: RESOLVER_ABI,
		functionName: "verifyName",
		args: [addr, proof],
	});

	// the L2 block the proof is for, from the proof
	const [{ commitProof }] = decodeAbiParameters([NAME_PROOF], proof);
	const { block, commit } = await proofBlock(d, commitProof);
	const l2 = createClient(d.l2);
	const [finalized, header] = await Promise.all([
		l2.getBlock({ blockTag: "finalized" }),
		l2.getBlock({ blockNumber: BigInt(block) }),
	]);
	const actual = await createClient(d.l2, "proof").readContract({
		address: d.L2ReverseRegistrar,
		abi: L2_REGISTRAR_ABI,
		functionName: "nameForAddr",
		args: [addr],
		blockNumber: BigInt(block),
	});
	if (actual !== primary) process.exitCode = 1;
	const behind = Number(finalized.number) - block;
	const rows: [string, string][] = [
		["name", JSON.stringify(primary)],
		["gateway", `${ms(gatewayMs)}, ${n((response!.length - 2) / 2)}-byte response`],
		["verify", `${n(gas)} gas (verifyName on the L1 fork)`],
		["proof", `L2 block ${n(block)} (${d.kind}: ${commit})`],
		[
			"finalized",
			`L2 block ${n(finalized.number)}: the proof is ${n(behind)} blocks (${duration(Number(finalized.timestamp - header.timestamp))}) behind`,
		],
		[
			"L2",
			actual === primary
				? `matches L2ReverseRegistrar.nameForAddr at L2 block ${n(block)}`
				: `differs: L2ReverseRegistrar.nameForAddr at L2 block ${n(block)} is ${JSON.stringify(actual)}`,
		],
	];
	for (const [k, v] of rows) console.log(`${k.padEnd(10)}${v}`);
} catch (err) {
	// viem's errors repeat the call: the first cause that isn't viem's wrapper says what failed
	const e = err as BaseError;
	console.error(e.walk?.((x) => !(x instanceof BaseError))?.message ?? e.shortMessage ?? e.message);
	if (d.kind === "op" && !minAgeSec) {
		console.error("(if the indexer accepts games early, pass --min-age with its INDEXER_MIN_AGE_SEC)");
	}
	process.exitCode = 1;
} finally {
	await foundry.shutdown();
}
