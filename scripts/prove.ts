// Prove one address's primary name through a running indexer and gateway, end to end on an L1 fork:
// deploys the chain's verifier and an L2ReverseResolver that points at the gateway, resolves
// `{addr}.{coinType}.reverse` with CCIP-Read, and compares the result with the L2 registrar.
//
//   bun run prove <address> [chain]            chain: the indexer/gateway ports of `bun run indexer:<chain>`
//   bun run prove <address> --indexer URL --gateway URL
//
// The chain and commit kind come from the indexer's /status. Needs .env RPC keys (an L1 fork, L2 reads).

import { Foundry } from "@adraffy/blocksmith";
import {
	type Commit,
	coinTypeFromChainId,
	createClient,
	type IndexerStatus,
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
	getAddress,
	type Hex,
	http,
	isAddress,
	namehash,
	parseAbi,
	toHex,
} from "viem";
import { packetToBytes } from "viem/ens";
import { deploymentOf, verifierContract } from "./verifiers.js";

// the ports of the package.json scripts
const PORTS: Record<string, [indexer: number, gateway: number]> = {
	optimism: [8100, 8200],
	linea: [8101, 8201],
	base: [8102, 8202],
	"base-inbox": [8103, 8203],
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
		`usage: bun run prove <address> [${Object.keys(PORTS).join(" | ")}]\n       bun run prove <address> --indexer URL --gateway URL`,
	);
	process.exit(1);
}

function parseArgs() {
	const args = process.argv.slice(2);
	let indexer = process.env.INDEXER_URL;
	let gateway = process.env.GATEWAY_URL;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--indexer") indexer = args[++i];
		else if (args[i] === "--gateway") gateway = args[++i];
		else rest.push(args[i]);
	}
	const [addr, chain] = rest;
	if (!addr || !isAddress(addr)) usage(addr && `not an address: ${addr}`);
	if (chain) {
		const ports = PORTS[chain] ?? usage(`no default ports for ${chain}: pass --indexer and --gateway`);
		indexer ??= `http://localhost:${ports[0]}`;
		gateway ??= `http://localhost:${ports[1]}`;
	}
	return {
		addr: getAddress(addr),
		indexer: (indexer ?? "http://localhost:8100").replace(/\/$/, ""),
		gateway: gateway ?? "http://localhost:8200",
	};
}

async function getJSON<T>(url: string): Promise<T> {
	const res = await fetch(url).catch((err) => usage(`${url}: ${err.message} (is the indexer running?)`));
	if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
	return res.json() as Promise<T>;
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

const { addr, indexer, gateway } = parseArgs();
const status = await getJSON<IndexerStatus>(`${indexer}/status`);
const [chain, d] =
	deploymentOf(status) ??
	usage(
		`${indexer}: no deployment for L1 ${status.l1ChainId} → L2 ${status.l2ChainId} (${status.kind}); an older indexer?`,
	);
if (!status.latestValid) usage(`${indexer}: no valid commit yet (synced to L2 block ${status.syncedBlock})`);
const blockTime = status.l2BlockMs ? `, ${status.l2BlockMs} ms blocks` : "";
const minAgeSec = status.minAgeSec ?? 0; // the verifier must accept what the indexer marks valid
const early = minAgeSec ? `, games accepted unchallenged after ${minAgeSec}s` : "";
console.log(
	`${chain} (${d.kind}, L1 ${d.l1.id} → L2 ${d.l2.id}${blockTime}${early}): indexer ${indexer}, gateway ${gateway}`,
);

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

	// the commit the proof is for: the gateway sends the indexer's commit proof as it is
	const [{ commitProof }] = decodeAbiParameters([NAME_PROOF], proof);
	const commits = await getJSON<Commit[]>(`${indexer}/commits?status=valid&limit=100`);
	const commit = commits.find((c) => c.commitProof === commitProof);
	const l2 = createClient(d.l2);
	const finalized = await l2.getBlock({ blockTag: "finalized" });

	const rows: [string, string][] = [
		["name", JSON.stringify(primary)],
		["gateway", `${ms(gatewayMs)}, ${n((response!.length - 2) / 2)}-byte response`],
		["verify", `${n(gas)} gas (verifyName on the L1 fork)`],
	];
	if (commit) {
		const block = await l2.getBlock({ blockNumber: BigInt(commit.l2Block) });
		const behind = Number(finalized.number) - commit.l2Block;
		const sec = Number(finalized.timestamp - block.timestamp);
		rows.push(
			["proof", `L2 block ${n(commit.l2Block)} (${d.kind} commit ${commit.id})`],
			["finalized", `L2 block ${n(finalized.number)}: the proof is ${n(behind)} blocks (${duration(sec)}) behind`],
		);
		const actual = await createClient(d.l2, "proof").readContract({
			address: d.L2ReverseRegistrar,
			abi: L2_REGISTRAR_ABI,
			functionName: "nameForAddr",
			args: [addr],
			blockNumber: BigInt(commit.l2Block),
		});
		rows.push([
			"L2",
			actual === primary
				? `matches L2ReverseRegistrar.nameForAddr at L2 block ${n(commit.l2Block)}`
				: `differs: L2ReverseRegistrar.nameForAddr at L2 block ${n(commit.l2Block)} is ${JSON.stringify(actual)}`,
		]);
		if (actual !== primary) process.exitCode = 1;
	} else {
		rows.push(
			["proof", "for a commit that isn't among the indexer's valid commits (another indexer, or retired)"],
			["finalized", `L2 block ${n(finalized.number)}`],
		);
	}
	for (const [k, v] of rows) console.log(`${k.padEnd(10)}${v}`);
} catch (err) {
	// viem's errors repeat the call: the first cause that isn't viem's wrapper says what failed
	const e = err as BaseError;
	console.error(e.walk?.((x) => !(x instanceof BaseError))?.message ?? e.shortMessage ?? e.message);
	process.exitCode = 1;
} finally {
	await foundry.shutdown();
}
