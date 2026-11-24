// Offline end-to-end test of Arbitrum (BoLD): a mock rollup on anvil that creates, confirms and
// challenges assertions with BoLD's event and hashes, an in-memory L2 with real headers, and the real
// ArbitrumCommitSource, indexer, gateway, ArbitrumVerifier and L2ReverseResolver.
//
// The indexer accepts assertions MIN_AGE L1 blocks old (INDEXER_MIN_AGE_L1_BLOCKS); two resolvers share the
// gateway: one with a confirmed-only verifier and one with the same MIN_AGE.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { serveEZCCIP } from "@adraffy/ezccip/serve";
import {
	ArbitrumCommitSource,
	IndexerDB,
	RegistrarIndexer,
	serveIndexer,
} from "@primary-name-gateway/registrar-indexer";
import {
	type ArbitrumDeployment,
	type AssertionState,
	assertionHash,
	assertionStateHash,
	coinTypeFromChainId,
	PLAIN_LAYOUT,
} from "@primary-name-gateway/shared";
import {
	type Address,
	createPublicClient,
	type Hex,
	http,
	keccak256,
	type PublicClient,
	parseAbi,
	stringToHex,
	zeroHash,
} from "viem";
import { createEZCCIP, RegistrarGateway, SqlNodeStore } from "../packages/registrar-gateway/src/index.js";
import { bunSqliteAdapter } from "../packages/registrar-gateway/src/sqlite.js";
import { FakeArbitrumL2 } from "./fake-arbitrum.js";

const CHAIN_ID = 42161;
const MIN_AGE = 5; // L1 blocks
const CONFIRM_PERIOD = 20; // MockBoLDRollup's confirmPeriodBlocks (the indexer checks for confirmation after it)
const REGISTRAR: Address = "0x0000000000D8e504002cC26E3Ec46D81971C1664";
const ADDR: Address = "0x1000000000000000000000000000000000000001";
const GENESIS = keccak256(stringToHex("genesis assertion"));

const RESOLVER_ABI = parseAbi([
	"function verifyName(address addr, bytes proof) view returns (string)",
	"error NotConfirmed(bytes32 assertionHash)",
	"error Challenged(bytes32 assertionHash)",
]);

describe("offline e2e: Arbitrum (BoLD)", () => {
	let foundry: Foundry;
	let l1: PublicClient;
	let rollup: Awaited<ReturnType<Foundry["deploy"]>>;
	let l2: FakeArbitrumL2;
	let deployment: ArbitrumDeployment;
	let db: IndexerDB;
	let indexer: RegistrarIndexer;
	let indexerServer: ReturnType<typeof serveIndexer>;
	let gateway: RegistrarGateway;
	let gatewayDB: Database;
	let ccip: Awaited<ReturnType<typeof serveEZCCIP>>;
	let confirmedOnly: Address;
	let early: Address;
	let acc = 0;

	const source = (minAgeL1Blocks: number) =>
		new ArbitrumCommitSource({
			deployment,
			l1,
			l2,
			lookbackBlocks: 1000,
			minAgeL1Blocks,
			maxAttempts: 1,
			l1BlockTag: "latest",
		});

	beforeAll(async () => {
		foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
		l1 = createPublicClient({ transport: http(`http://127.0.0.1:${foundry.port}`) });
		rollup = await foundry.deploy({ file: "MockBoLD", contract: "MockBoLDRollup" });
		const block = Number(await l1.getBlockNumber());
		await foundry.confirm(
			rollup.setAssertion(GENESIS, {
				firstChildBlock: 0,
				secondChildBlock: 0,
				createdAtBlock: block,
				isFirstChild: true,
				status: 2,
				configHash: zeroHash,
			}),
		);
		await foundry.confirm(rollup.setLatestConfirmed(GENESIS));
		l2 = new FakeArbitrumL2(CHAIN_ID, REGISTRAR, Math.floor(Date.now() / 1000) - 3600);
		deployment = {
			kind: "arbitrum",
			l1: { id: 31337, name: "blocksmith", drpcSlug: "", alchemySlug: "" },
			l2: { id: CHAIN_ID, name: "fake", drpcSlug: "", alchemySlug: "" },
			Rollup: rollup.target as Address,
			L2ReverseRegistrar: REGISTRAR,
			layout: PLAIN_LAYOUT,
			registrarCreatedAtBlock: 0,
		};
		db = new IndexerDB(":memory:");
		indexer = new RegistrarIndexer({ deployment, l2, db, source: source(MIN_AGE) });
		indexerServer = serveIndexer(indexer, db, 0);
		gatewayDB = new Database(":memory:");
		gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), {
			indexerURL: indexerServer.url.origin,
			keepCommits: 2,
			serveDelaySec: 0,
		});
		ccip = await serveEZCCIP(createEZCCIP(gateway), { log: false });
		const resolver = async (minAge: number) => {
			const v = await foundry.deploy({ file: "ArbitrumVerifier", args: [rollup.target, minAge, 1000] });
			const r = await foundry.deploy({
				file: "L2ReverseResolver",
				args: [v.target, REGISTRAR, 0, coinTypeFromChainId(CHAIN_ID), [ccip.endpoint]],
			});
			return r.target as Address;
		};
		confirmedOnly = await resolver(0);
		early = await resolver(MIN_AGE);
	}, 120_000);

	afterAll(async () => {
		await ccip?.shutdown();
		indexerServer?.stop(true);
		db?.close();
		gatewayDB?.close();
		await foundry?.shutdown();
	});

	// an assertion naming the L2 head, as a child of `parent`
	async function assert(parent: Hex): Promise<Hex> {
		const afterState: AssertionState = {
			globalState: { bytes32Vals: [l2.headerOf(l2.head.number).hash, zeroHash], u64Vals: [0n, 0n] },
			machineStatus: 1,
			endHistoryRoot: zeroHash,
		};
		const inboxAcc = keccak256(stringToHex(`inbox ${++acc}`));
		await foundry.confirm(rollup.createAssertion(parent, afterState, inboxAcc));
		return assertionHash(parent, assertionStateHash(afterState), inboxAcc);
	}

	async function mineL1(blocks: number) {
		await l1.request({ method: "anvil_mine" as never, params: [`0x${blocks.toString(16)}`] as never });
	}

	async function sync() {
		await indexer.tick();
		await gateway.sync();
	}

	const status = (h: Hex) =>
		db.getCommits(undefined, 100).find((c) => "assertionHash" in c && c.assertionHash === h)?.status;

	function verify(resolver: Address) {
		const { proof } = gateway.proveName(ADDR);
		return l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [ADDR, proof] });
	}

	let first: Hex;
	let second: Hex;
	let third: Hex;

	test("a confirmed assertion is served, and both verifiers accept it", async () => {
		l2.setName(ADDR, "first.eth");
		l2.mine();
		first = await assert(GENESIS);
		await sync();
		expect(status(first)).toBe("pending"); // too young, not confirmed
		await foundry.confirm(rollup.confirm(first));
		await mineL1(CONFIRM_PERIOD);
		await sync();
		expect(status(first)).toBe("valid");
		expect(await verify(confirmedOnly)).toBe("first.eth");
		expect(await verify(early)).toBe("first.eth");
	}, 60_000);

	test("pending assertions MIN_AGE old are served through a chain; a confirmed-only verifier refuses", async () => {
		l2.setName(ADDR, "second.eth");
		l2.mine();
		second = await assert(first);
		l2.setName(ADDR, "third.eth");
		l2.mine();
		third = await assert(second);
		await sync();
		expect(status(third)).toBe("pending");
		await mineL1(MIN_AGE);
		await sync();
		expect(status(second)).toBe("valid");
		expect(status(third)).toBe("valid");
		expect(gateway.commits.at(-1)?.id).toBe(db.getCommits("valid", 1)[0].id);
		expect(await verify(early)).toBe("third.eth"); // 2 links from `first`
		await expect(verify(confirmedOnly)).rejects.toThrow(/NotConfirmed/);
	}, 60_000);

	test("a rival on the way makes the early commit invalid; the one before it is served", async () => {
		const { proof } = gateway.proveName(ADDR);
		await assert(second); // a second child of `second`: a challenge
		await expect(
			l1.readContract({ address: early, abi: RESOLVER_ABI, functionName: "verifyName", args: [ADDR, proof] }),
		).rejects.toThrow(/Challenged/);
		await sync();
		expect(status(third)).toBe("invalid");
		expect(status(second)).toBe("valid"); // its parent `first` has no rival
		expect(await verify(early)).toBe("second.eth");
	}, 60_000);

	test("restarting confirmed-only re-checks the valid commits", async () => {
		const strict = new RegistrarIndexer({ ...indexer.config, source: source(0) });
		await mineL1(CONFIRM_PERIOD);
		await strict.tick();
		expect(strict.status().minAgeL1Blocks).toBe(0);
		expect(status(first)).toBe("valid"); // confirmed
		expect(status(second)).toBe("pending"); // accepted early, not confirmed
		expect(db.getCommits("valid", 1)[0].l2Block).toBe(1);
	}, 60_000);
});
