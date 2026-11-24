// Prove one address's primary name through a gateway, end to end on an L1 fork: deploys the chain's
// verifier and an L2ReverseResolver that points at the gateway, resolves `{addr}.{coinType}.reverse`
// with CCIP-Read as a client would, and compares the result with the L2 registrar at the proof's block.
// Only the gateway (and RPC) is contacted: the proof itself says which L2 block it is for.
//
//   bun run prove <address> <chain> [--gateway URL] [--min-age SEC] [--public]
//
// chain: a deployment (base, base-inbox, optimism, linea, ...). --gateway: its URL, default
// http://localhost:<port> with the port of `bun run gateway:<chain>`. --min-age: the verifier's
// early acceptance, as the indexer's: OP Stack fault proofs in seconds (INDEXER_MIN_AGE_SEC), Arbitrum in
// L1 blocks (INDEXER_MIN_AGE_L1_BLOCKS); default that variable, or 0. Needs .env RPC keys, unless
// --public: the L1 fork runs on the public RPC (rpcURL "public"), and the L2 isn't read, so the
// proof's L2 block and the comparison with the registrar are left out.

import { Foundry } from "@adraffy/blocksmith";
import {
	assertionHash,
	coinTypeFromChainId,
	createClient,
	DEPLOYMENTS,
	type Deployment,
	decodeArbitrumCommitProof,
	decodeOPBatchInboxCommitProof,
	decodeOPFaultCommitProof,
	redactURL,
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
const GATEWAY_PORTS: Record<string, number> = {
	optimism: 8200,
	linea: 8201,
	base: 8202,
	"base-inbox": 8203,
	arbitrum: 8204,
};

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
		`usage: bun run prove <address> <${Object.keys(DEPLOYMENTS).join(" | ")}> [--gateway URL] [--min-age SEC] [--public]`,
	);
	process.exit(1);
}

function parseArgs() {
	const args = process.argv.slice(2);
	let gateway = process.env.GATEWAY_URL;
	let minAge: string | undefined;
	let publicRPC = false;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--gateway") gateway = args[++i];
		else if (args[i] === "--min-age") minAge = args[++i];
		else if (args[i] === "--public") publicRPC = true;
		else rest.push(args[i]);
	}
	const [addr, chain] = rest;
	if (!addr || !isAddress(addr)) usage(addr && `not an address: ${addr}`);
	const d = (chain && DEPLOYMENTS[chain]) || usage(chain ? `unknown chain: ${chain}` : "which chain?");
	const port = GATEWAY_PORTS[chain];
	gateway ??= port ? `http://localhost:${port}` : usage(`no default gateway for ${chain}: pass --gateway`);
	minAge ??= d.kind === "arbitrum" ? process.env.INDEXER_MIN_AGE_L1_BLOCKS : process.env.INDEXER_MIN_AGE_SEC;
	const minAgeSec = Number(minAge ?? 0);
	if (!Number.isInteger(minAgeSec) || minAgeSec < 0) usage(`not a number of seconds: ${minAge}`);
	return { addr: getAddress(addr), chain, d, gateway, minAgeSec, publicRPC };
}

const n = (x: number | bigint) => x.toLocaleString("en-US");

// "label... result (time)" on one line, so a slow step shows what it's waiting on
async function step<T>(label: string, f: () => Promise<T>, result?: (r: T) => string): Promise<T> {
	process.stdout.write(`${label}... `);
	const t0 = performance.now();
	try {
		const r = await f();
		const shown = result?.(r);
		console.log(`${shown ? `${shown} ` : ""}(${ms(performance.now() - t0)})`);
		return r;
	} catch (err) {
		console.log("failed");
		throw err;
	}
}
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
		case "arbitrum": {
			const p = decodeArbitrumCommitProof(commitProof);
			let h = p.anchor; // walk the chain to the commit's assertion
			for (let i = 0; i < p.chain.length; i += 2) h = assertionHash(h, p.chain[i], p.chain[i + 1]);
			const links = p.chain.length / 2;
			return {
				block: Number(hexToBigInt((fromRlp(p.l2Header) as Hex[])[8])),
				commit: `assertion ${h.slice(0, 10)}…, ${links} link${links > 1 ? "s" : ""} from a confirmed one`,
			};
		}
	}
}

const { addr, chain, d, gateway, minAgeSec, publicRPC } = parseArgs();
const blockMs = "l2Blocks" in d ? `, ${d.l2Blocks[d.l2Blocks.length - 1].ms} ms blocks` : "";
const early = !minAgeSec
	? ""
	: d.kind === "arbitrum"
		? `, assertions accepted unchallenged after ${minAgeSec} L1 blocks`
		: `, games accepted unchallenged after ${minAgeSec}s`;
console.log(`${chain} (${d.kind}, L1 ${d.l1.id}, L2 ${d.l2.id}${blockMs}${early}): gateway ${gateway}`);

const forkURL = rpcURL(d.l1, publicRPC ? "public" : "default");
const foundry = await step(`launching an L1 fork of ${redactURL(forkURL)}`, () =>
	Foundry.launch({
		root: `${import.meta.dir}/../packages/contracts`,
		fork: forkURL,
		infoLog: false,
	}),
);
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
	const fork = await l1.getBlock();
	console.log(`L1 fork at block ${n(fork.number)} (${new Date(Number(fork.timestamp) * 1000).toISOString()})`);
	const { contract, args } = verifierContract(d, minAgeSec);
	const verifier = await step(
		`deploying ${contract}`,
		() => foundry.deploy({ file: contract, args }),
		(c) => c.target as string,
	);
	const coinType = coinTypeFromChainId(d.l2.id);
	const resolver = await step(
		"deploying L2ReverseResolver",
		() =>
			foundry.deploy({
				file: "L2ReverseResolver",
				args: [verifier.target, d.L2ReverseRegistrar, d.layout.namesSlot, coinType, [gateway]],
			}),
		(c) => c.target as string,
	);

	// ENSIP-19 reverse name, resolved as a client would (viem follows the OffchainLookup)
	const name = `${addr.slice(2).toLowerCase()}.${coinType.toString(16)}.reverse`;
	const call = encodeFunctionData({ abi: RESOLVER_ABI, functionName: "name", args: [namehash(name)] });
	const resolve = () =>
		l1.readContract({
			address: resolver.target as Address,
			abi: RESOLVER_ABI,
			functionName: "resolve",
			args: [toHex(packetToBytes(name)), call],
		});
	// the first resolve pulls the rollup's and the verifier's L1 state into the fork over RPC: slow, and
	// not what a client sees, so the timed one is the second
	await step("warming the fork (a first resolve loads the L1 state it reads)", resolve);
	const result = await step(`resolving ${name}`, resolve);
	const primary = decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "name", data: result });
	const [proof] = decodeAbiParameters([{ type: "bytes" }], response!);
	const gas = await step("estimating verifyName gas", () =>
		l1.estimateContractGas({
			address: resolver.target as Address,
			abi: RESOLVER_ABI,
			functionName: "verifyName",
			args: [addr, proof],
		}),
	);

	const rows: [string, string][] = [
		["name", JSON.stringify(primary)],
		["gateway", `${ms(gatewayMs)}, ${n((response!.length - 2) / 2)}-byte response`],
		["verify", `${n(gas)} gas (verifyName on the L1 fork)`],
	];
	if (!publicRPC) {
		// the L2 block the proof is for, from the proof, and the registrar there
		const [{ commitProof }] = decodeAbiParameters([NAME_PROOF], proof);
		const { block, commit, finalized, header, actual } = await step("reading the L2 at the proof's block", async () => {
			const { block, commit } = await proofBlock(d, commitProof);
			const l2 = createClient(d.l2);
			const [finalized, header, actual] = await Promise.all([
				l2.getBlock({ blockTag: "finalized" }),
				l2.getBlock({ blockNumber: BigInt(block) }),
				createClient(d.l2, "proof").readContract({
					address: d.L2ReverseRegistrar,
					abi: L2_REGISTRAR_ABI,
					functionName: "nameForAddr",
					args: [addr],
					blockNumber: BigInt(block),
				}),
			]);
			return { block, commit, finalized, header, actual };
		});
		if (actual !== primary) process.exitCode = 1;
		const behind = Number(finalized.number) - block;
		rows.push(
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
		);
	}
	console.log();
	for (const [k, v] of rows) console.log(`${k.padEnd(10)}${v}`);
} catch (err) {
	// viem's errors repeat the call: the first cause that isn't viem's wrapper says what failed
	const e = err as BaseError;
	console.error(e.walk?.((x) => !(x instanceof BaseError))?.message ?? e.shortMessage ?? e.message);
	if ((d.kind === "op" || d.kind === "arbitrum") && !minAgeSec) {
		const env = d.kind === "arbitrum" ? "INDEXER_MIN_AGE_L1_BLOCKS" : "INDEXER_MIN_AGE_SEC";
		console.error(`(if the indexer accepts commits early, pass --min-age with its ${env})`);
	}
	process.exitCode = 1;
} finally {
	await foundry.shutdown();
}
