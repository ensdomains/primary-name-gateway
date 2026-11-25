// Offline end-to-end test for Base-shaped OP Stack chains (no RPC needed):
//
//   - output root games (not super roots), of a custom game type (621, Base's AggregateVerifier),
//     whose extraData is l2BlockNumber . parentGame . intermediate roots
//   - the Ownable registrar layout (names at slot 0, owner at slot 1) with OwnershipTransferred events
//   - maxL2SequenceLag in L2 blocks
//
// Same stack as offline.test.ts: blocksmith + mock OP contracts, FakeOPRollup, the real indexer,
// gateway, OPFaultVerifier and L2ReverseResolver.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { serveEZCCIP } from "@adraffy/ezccip/serve";
import { IndexerDB, OPCommitSource, RegistrarIndexer, serveIndexer } from "@primary-name-gateway/registrar-indexer";
import { coinTypeFromChainId, type OPDeployment, OWNABLE_LAYOUT } from "@primary-name-gateway/shared";
import {
	type Address,
	concat,
	createPublicClient,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	http,
	keccak256,
	namehash,
	numberToHex,
	type PublicClient,
	parseAbi,
	stringToHex,
	toHex,
	zeroAddress,
} from "viem";
import { packetToBytes } from "viem/ens";
import { createEZCCIP, RegistrarGateway, SqlNodeStore } from "../packages/registrar-gateway/src/index.js";
import { bunSqliteAdapter } from "../packages/registrar-gateway/src/sqlite.js";
import { type FakeBlock, FakeOPRollup } from "./fake-rollup.js";

const CHAIN_ID = 8453;
const COIN_TYPE = coinTypeFromChainId(CHAIN_ID);
const GAME_TYPE = 621;
const MAX_SEQUENCE_LAG = 10; // L2 blocks (output root games)
const REGISTRAR: Address = "0x0000000000D8e504002cC26E3Ec46D81971C1664";

const RESOLVER_ABI = parseAbi([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function verifyName(address addr, bytes proof) view returns (string)",
	"function name(bytes32) view returns (string)",
	"error InvalidGame(address game)",
	"error StaleGame(uint256 l2SequenceNumber, uint256 anchorSequenceNumber)",
	"error InvalidOutputRoot()",
]);

const A = {
	short: "0x1000000000000000000000000000000000000001",
	long: "0x2000000000000000000000000000000000000002",
	never: "0x7000000000000000000000000000000000000007",
} as const satisfies Record<string, Address>;

describe("offline e2e (base: output root games, Ownable layout)", () => {
	let foundry: Foundry;
	let l1: PublicClient;
	let asr: Awaited<ReturnType<Foundry["deploy"]>>;
	let factory: Awaited<ReturnType<Foundry["attach"]>>;
	let rollup: FakeOPRollup;
	let db: IndexerDB;
	let indexer: RegistrarIndexer;
	let indexerServer: ReturnType<typeof serveIndexer>;
	let gateway: RegistrarGateway;
	let gatewayDB: Database;
	let ccip: Awaited<ReturnType<typeof serveEZCCIP>>;
	let resolver: Address;
	const games: { address: Address; gameIndex: number }[] = [];

	beforeAll(async () => {
		foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
		l1 = createPublicClient({ transport: http(`http://127.0.0.1:${foundry.port}`) });
		asr = await foundry.deploy({ file: "MockOP", contract: "MockAnchorStateRegistry", args: [GAME_TYPE] });
		factory = await foundry.attach({
			to: await asr.disputeGameFactory(),
			file: "MockOP",
			contract: "MockDisputeGameFactory",
		});

		rollup = new FakeOPRollup(CHAIN_ID, REGISTRAR, Math.floor(Date.now() / 1000) - 3600, 2, [], OWNABLE_LAYOUT);
		const deployment: OPDeployment = {
			kind: "op",
			l1: { id: 31337, name: "blocksmith", drpcSlug: "", alchemySlug: "" },
			l2: { id: CHAIN_ID, name: "fake-base", drpcSlug: "", alchemySlug: "" },
			AnchorStateRegistry: asr.target as Address,
			L2ReverseRegistrar: REGISTRAR,
			layout: OWNABLE_LAYOUT,
			registrarCreatedAtBlock: 0,
			l2Blocks: [{ block: 0, timestamp: rollup.genesisTimestamp, ms: rollup.blockTime * 1000 }],
			gameFinalitySec: 0,
		};
		db = new IndexerDB(":memory:");
		indexer = new RegistrarIndexer({
			deployment,
			l2: rollup,
			db,
			source: new OPCommitSource({
				deployment,
				l1,
				l2: rollup,
				lookbackSec: 86400,
				minFinalAgeSec: 0,
				maxAttempts: 1,
				l1BlockTag: "latest", // anvil
			}),
		});
		indexerServer = serveIndexer(indexer, db, 0);

		gatewayDB = new Database(":memory:");
		gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), {
			indexerURLs: [indexerServer.url.origin],
			keepCommits: 2,
			serveDelaySec: 0,
		});
		ccip = await serveEZCCIP(createEZCCIP(gateway), { log: false });

		const verifier = await foundry.deploy({
			file: "OPFaultVerifier",
			args: [asr.target, CHAIN_ID, MAX_SEQUENCE_LAG, 0],
		});
		const r = await foundry.deploy({
			file: "L2ReverseResolver",
			args: [verifier.target, REGISTRAR, OWNABLE_LAYOUT.namesSlot, COIN_TYPE, [ccip.endpoint]],
		});
		resolver = r.target as Address;
	}, 120_000);

	afterAll(async () => {
		await ccip?.shutdown();
		indexerServer?.stop(true);
		db?.close();
		gatewayDB?.close();
		await foundry?.shutdown();
	});

	// an output root game for a block, with AggregateVerifier-style extraData
	async function propose({ outputRoot, block = rollup.head }: { outputRoot?: Hex; block?: FakeBlock } = {}) {
		const parent = games.at(-1)?.address ?? zeroAddress;
		const extraData = concat([
			numberToHex(block.number, { size: 32 }),
			parent,
			keccak256(stringToHex(`intermediate ${block.number}`)),
		]);
		const gameIndex = Number(await factory.gameCount());
		await foundry.confirm(factory.create(GAME_TYPE, outputRoot ?? block.outputRoot, extraData, block.number));
		const [, , address] = await factory.gameAtIndex(gameIndex);
		const game = { address: address as Address, gameIndex };
		games.push(game);
		return game;
	}

	async function sync() {
		await indexer.tick();
		await gateway.sync();
	}

	async function resolveName(addr: Address): Promise<string> {
		const name = `${addr.slice(2).toLowerCase()}.${COIN_TYPE.toString(16)}.reverse`;
		const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: "name", args: [namehash(name)] });
		const result = await l1.readContract({
			address: resolver,
			abi: RESOLVER_ABI,
			functionName: "resolve",
			args: [toHex(packetToBytes(name)), data],
		});
		return decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "name", data: result });
	}

	function verifyName(addr: Address, id?: number) {
		const { proof } = gateway.proveName(addr, id);
		return l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [addr, proof] });
	}

	test("round 1: names resolve from an output root game", async () => {
		rollup.transferOwnership("0x00000000000000000000000000000000000000AB");
		rollup.setName(A.short, "raffy.base.eth");
		rollup.setName(A.long, `${"long".repeat(20)}.base.eth`);
		rollup.mine();
		const game = await propose();
		await sync();
		const commit = db.getCommit(game.gameIndex);
		expect(commit?.status).toBe("pending");
		expect(commit?.l2Block).toBe(rollup.head.number);

		await foundry.confirm(asr.finalize(game.address));
		await sync();
		expect(await resolveName(A.short)).toBe("raffy.base.eth");
		expect(await resolveName(A.long)).toBe(`${"long".repeat(20)}.base.eth`);
		expect(await resolveName(A.never)).toBe("");
	}, 60_000);

	test("round 2: name and ownership changes arrive as a patch; the older game verifies within the lag", async () => {
		rollup.transferOwnership("0x00000000000000000000000000000000000000CD");
		rollup.setName(A.short, "raffy2.base.eth");
		rollup.setName(A.long, "");
		rollup.mine(3);
		const game = await propose();
		await foundry.confirm(asr.finalize(game.address));
		await sync();
		expect(gateway.stats).toMatchObject({ snapshots: 1, patches: 1 });
		expect(await resolveName(A.short)).toBe("raffy2.base.eth");
		expect(await resolveName(A.long)).toBe("");
		expect(await verifyName(A.short, games[0].gameIndex)).toBe("raffy.base.eth"); // 3 blocks behind
	}, 60_000);

	test("a lying output root game is never served", async () => {
		rollup.setName(A.short, "evil.base.eth");
		rollup.mine();
		const bad = await propose({ outputRoot: keccak256(stringToHex("lies")) });
		await sync();
		expect(db.getCommit(bad.gameIndex)?.status).toBe("invalid");
		expect(await resolveName(A.short)).toBe("raffy2.base.eth");
	}, 60_000);

	test("games more than maxL2SequenceLag blocks behind the anchor are rejected", async () => {
		rollup.mine(MAX_SEQUENCE_LAG);
		const game = await propose();
		await foundry.confirm(asr.finalize(game.address));
		await sync();
		expect(await resolveName(A.short)).toBe("evil.base.eth"); // the honest game for that change
		await expect(verifyName(A.short, games[1].gameIndex)).rejects.toThrow(/StaleGame/);
	}, 60_000);
});
