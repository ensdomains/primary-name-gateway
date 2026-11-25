// Prove one address's primary name through a gateway, end to end on an L1 fork: deploys the chain's
// verifier and an L2ReverseResolver that points at the gateway, resolves `{addr}.{coinType}.reverse`
// with CCIP-Read as a client would, and compares the result with the L2 registrar at the proof's block.
// Only the gateway (and RPC) is contacted: the proof itself says which L2 block it is for.
//
//   bun run prove <address> <chain> [--gateway URL] [--min-age SEC] [--public]
//
// chain: a deployment (base, base-inbox, optimism, linea, ...). --gateway: its URL (or GATEWAY_URL),
// default http://localhost:<port> with the port of `bun run gateway:<chain>`. --min-age: the verifier's
// early acceptance (OP Stack fault proofs in seconds, Arbitrum in L1 blocks); default what the
// gateway's /status reports from its indexer, which the commits it serves assume. Needs .env RPC keys,
// unless --public: the L1 fork runs on the public RPC (rpcURL "public"), and the L2 isn't read, so the
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
	styles,
	useColor,
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
	celo: 8205,
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
	const minAgeArg = minAge === undefined ? undefined : Number(minAge);
	if (minAgeArg !== undefined && (!Number.isInteger(minAgeArg) || minAgeArg < 0))
		usage(`--min-age: not a whole number of ${d.kind === "arbitrum" ? "L1 blocks" : "seconds"}: ${minAge}`);
	return { addr: getAddress(addr), chain, d, gateway, minAgeArg, publicRPC };
}

const n = (x: number | bigint) => x.toLocaleString("en-US");

// colors on a terminal (NO_COLOR turns them off), plain text when piped
const color = useColor();
const { bold, dim, red, green, yellow } = styles(color);

// A step shows what it's waiting on while it runs, then becomes "✓ label  time" (or "✗ label").
async function step<T>(label: string, f: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	process.stdout.write(color ? dim(`… ${label}`) : `${label}... `);
	const done = (mark: string, rest: string) =>
		process.stdout.write(color ? `\r\x1b[2K${mark} ${label}${rest}\n` : `${rest.trim()}\n`);
	try {
		const r = await f();
		done(green("✓"), `  ${dim(ms(performance.now() - t0))}`);
		return r;
	} catch (err) {
		done(red("✗"), color ? "" : " failed");
		throw err;
	}
}

// key / value rows in a box; `paint` colors a value after it is padded
function table(rows: [string, string, ((s: string) => string)?][]) {
	const kw = Math.max(...rows.map(([k]) => k.length));
	const vw = Math.max(...rows.map(([, v]) => v.length));
	const rule = (l: string, m: string, r: string) => dim(`${l}${"─".repeat(kw + 2)}${m}${"─".repeat(vw + 2)}${r}`);
	const bar = dim("│");
	console.log(rule("┌", "┬", "┐"));
	for (const [k, v, p] of rows)
		console.log(`${bar} ${bold(k.padEnd(kw))} ${bar} ${(p ?? String)(v.padEnd(vw))} ${bar}`);
	console.log(rule("└", "┴", "┘"));
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

const { addr, chain, d, gateway, minAgeArg, publicRPC } = parseArgs();
const blockMs = "l2Blocks" in d ? `, ${d.l2Blocks[d.l2Blocks.length - 1].ms} ms blocks` : "";
console.log(`${bold(chain)}: ${dim(`${d.kind} commits, L1 ${d.l1.id}, L2 ${d.l2.id}${blockMs}`)}`);
console.log(`${dim("gateway")} ${gateway}\n`);

// the gateway's /status (gatewayStatus): what it serves, and the early acceptance its commits assume
type GatewayStatus = {
	chain?: string;
	minAgeSec?: number;
	minAgeL1Blocks?: number;
	served?: { id: number; l2Block: number };
};
const status = await step("reading the gateway's status", async () => {
	const res = await fetch(new URL("status", gateway.endsWith("/") ? gateway : `${gateway}/`)).catch((err) => {
		throw new Error(`gateway ${gateway}: ${err instanceof Error ? err.message : err} (is it running?)`);
	});
	if (!res.ok) throw new Error(`gateway ${gateway}/status: ${res.status}`);
	return (await res.json()) as GatewayStatus;
}).catch((err: Error) => {
	console.error(red(err.message));
	process.exit(1);
});
if (status.chain && status.chain !== chain) {
	console.error(red(`the gateway at ${gateway} serves ${status.chain}, not ${chain}`));
	process.exit(1);
}
if (!status.served) {
	console.error(red(`the gateway at ${gateway} has no commit yet`));
	process.exit(1);
}
const fromGateway = d.kind === "arbitrum" ? status.minAgeL1Blocks : status.minAgeSec;
const minAgeSec = minAgeArg ?? fromGateway ?? 0;
const unit = d.kind === "arbitrum" ? " L1 blocks" : "s";
console.log(
	dim(
		`  serving commit ${status.served.id} (L2 block ${n(status.served.l2Block)}); ${
			minAgeSec ? `accepted unchallenged after ${minAgeSec}${unit}` : "finalized commits only"
		}${minAgeArg === undefined ? "" : fromGateway === minAgeArg ? "" : ` (--min-age; the gateway says ${fromGateway ?? 0})`}`,
	),
);

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
				response = await ccipRequest(params).catch((err: BaseError & { status?: number }) => {
					// an HTTP status means it answered (e.g. 503 while it syncs); without one it's unreachable
					const hint = err.status ? "" : " (is it running?)";
					throw new Error(`gateway ${params.urls.join(", ")}: ${err.details ?? err.shortMessage}${hint}`);
				});
				gatewayMs = performance.now() - t0;
				return response;
			},
		},
	});
	const fork = await l1.getBlock();
	console.log(dim(`  L1 block ${n(fork.number)}, ${new Date(Number(fork.timestamp) * 1000).toISOString()}`));
	const { contract, args } = verifierContract(d, minAgeSec);
	const verifier = await step(`deploying ${contract}`, () => foundry.deploy({ file: contract, args }));
	const coinType = coinTypeFromChainId(d.l2.id);
	const resolver = await step("deploying L2ReverseResolver", () =>
		foundry.deploy({
			file: "L2ReverseResolver",
			args: [verifier.target, d.L2ReverseRegistrar, d.layout.namesSlot, coinType, [gateway]],
		}),
	);

	// ENSIP-19 reverse name, resolved as a client would (viem follows the OffchainLookup)
	const reverseName = (a: Address) => `${a.slice(2).toLowerCase()}.${coinType.toString(16)}.reverse`;
	const resolve = (name: string) =>
		l1.readContract({
			address: resolver.target as Address,
			abi: RESOLVER_ABI,
			functionName: "resolve",
			args: [
				toHex(packetToBytes(name)),
				encodeFunctionData({ abi: RESOLVER_ABI, functionName: "name", args: [namehash(name)] }),
			],
		});
	// The first resolve pulls the rollup's and the verifier's L1 state into the fork over RPC: slow, and
	// not what a client sees. It's for an address with no name, so nothing about the real one is warm.
	const warmup = reverseName("0xffffffffffffffffffffffffffffffffffffffff");
	await step("warming the fork", () => resolve(warmup));
	const result = await step(`resolving ${addr}`, () => resolve(reverseName(addr)));
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

	const rows: [string, string, ((s: string) => string)?][] = [
		primary ? ["name", primary, (s) => bold(green(s))] : ["name", "(none)", yellow],
		["gateway", `${ms(gatewayMs)}, ${n((response!.length - 2) / 2)} bytes`],
		["verify", `${n(gas)} gas`],
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
			["proof", `L2 block ${n(block)}`],
			["commit", commit],
			["finalized", `L2 block ${n(finalized.number)}`],
			["behind", `${duration(Number(finalized.timestamp - header.timestamp))} (${n(behind)} blocks)`],
			actual === primary
				? ["L2", "✓ matches nameForAddr", green]
				: ["L2", `✗ nameForAddr is ${JSON.stringify(actual)}`, red],
		);
	}
	console.log();
	table(rows);
} catch (err) {
	// viem's errors repeat the call: the first cause that isn't viem's wrapper says what failed
	const e = err as BaseError;
	console.error(red(e.walk?.((x) => !(x instanceof BaseError))?.message ?? e.shortMessage ?? e.message));
	process.exitCode = 1;
} finally {
	await foundry.shutdown();
}
