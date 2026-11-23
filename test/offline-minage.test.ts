// Offline test of OPFaultVerifier.minAgeSec ("unchallenged after X"), for both challenge markers:
// OP's FaultDisputeGame (claimDataLen) and Base's AggregateVerifier (type 621, counteredBy...).
//
// Two resolvers share one gateway: one with a finalized-only verifier (minAgeSec = 0) and one that
// accepts games unchallenged for MIN_AGE. The indexer runs with the same MIN_AGE.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexerDB, OPCommitSource, RegistrarIndexer, serveIndexer } from "@primary-name-gateway/registrar-indexer";
import { coinTypeFromChainId, type OPDeployment, PLAIN_LAYOUT } from "@primary-name-gateway/shared";
import { Foundry } from "@adraffy/blocksmith";
import { serve } from "@namestone/ezccip/serve";
import { type Address, concat, createPublicClient, http, numberToHex, parseAbi, type PublicClient, zeroAddress } from "viem";
import { createEZCCIP, RegistrarGateway, SqlNodeStore } from "../packages/registrar-gateway/src/index.js";
import { bunSqliteAdapter } from "../packages/registrar-gateway/src/sqlite.js";
import { FakeOPRollup } from "./fake-rollup.js";

const MIN_AGE = 6 * 3600;
const REGISTRAR: Address = "0x0000000000D8e504002cC26E3Ec46D81971C1664";
const ADDR: Address = "0x1000000000000000000000000000000000000001";

const RESOLVER_ABI = parseAbi([
	"function verifyName(address addr, bytes proof) view returns (string)",
	"error InvalidGame(address game)",
]);

describe.each([
	{ name: "fault dispute game (OP)", gameType: 0, chainId: 10 },
	{ name: "AggregateVerifier (Base)", gameType: 621, chainId: 8453 },
])("minAgeSec: $name", ({ gameType, chainId }) => {
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
	let ccip: Awaited<ReturnType<typeof serve>>;
	let early: Address; // resolver with minAgeSec = MIN_AGE
	let finalOnly: Address; // resolver with minAgeSec = 0

	beforeAll(async () => {
		foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
		l1 = createPublicClient({ transport: http(`http://127.0.0.1:${foundry.port}`) });
		asr = await foundry.deploy({ file: "MockOP", contract: "MockAnchorStateRegistry", args: [gameType] });
		factory = await foundry.attach({ to: await asr.disputeGameFactory(), file: "MockOP", contract: "MockDisputeGameFactory" });
		rollup = new FakeOPRollup(chainId, REGISTRAR, Math.floor(Date.now() / 1000) - 3600);
		const deployment: OPDeployment = {
			kind: "op",
			l1: { id: 31337, name: "blocksmith", drpcSlug: "", alchemySlug: "" },
			l2: { id: chainId, name: "fake", drpcSlug: "", alchemySlug: "" },
			AnchorStateRegistry: asr.target as Address,
			L2ReverseRegistrar: REGISTRAR,
			layout: PLAIN_LAYOUT,
			registrarCreatedAtBlock: 0,
			l2BlockTime: rollup.blockTime,
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
				minAgeSec: MIN_AGE,
			}),
		});
		indexerServer = serveIndexer(indexer, db, 0);
		gatewayDB = new Database(":memory:");
		gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), {
			indexerURL: indexerServer.url.origin,
			keep: 2,
			marginSec: 0,
		});
		ccip = await serve(createEZCCIP(gateway), { protocol: "raw", log: false });
		const resolver = async (minAge: number) => {
			const v = await foundry.deploy({ file: "OPFaultVerifier", args: [asr.target, chainId, 1_000_000, minAge] });
			const r = await foundry.deploy({
				file: "L2ReverseResolver",
				args: [v.target, REGISTRAR, 0, coinTypeFromChainId(chainId), [ccip.endpoint]],
			});
			return r.target as Address;
		};
		early = await resolver(MIN_AGE);
		finalOnly = await resolver(0);
	}, 120_000);

	afterAll(async () => {
		await ccip?.shutdown();
		indexerServer?.stop(true);
		db?.close();
		gatewayDB?.close();
		await foundry?.shutdown();
	});

	async function propose() {
		const block = rollup.head;
		const extraData = concat([numberToHex(block.number, { size: 32 }), zeroAddress]);
		const gameIndex = Number(await factory.gameCount());
		await foundry.confirm(factory.create(gameType, block.outputRoot, extraData, block.number));
		const [, , address] = await factory.gameAtIndex(gameIndex);
		return { address: address as Address, gameIndex };
	}

	async function elapse(sec: number) {
		await l1.request({ method: "evm_increaseTime" as any, params: [sec] as any });
		await l1.request({ method: "evm_mine" as any, params: [] as any });
	}

	async function sync() {
		await indexer.tick();
		await gateway.sync();
	}

	function verify(resolver: Address) {
		const { proof } = gateway.proveName(ADDR);
		return l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [ADDR, proof] });
	}

	test("an unchallenged game is served after minAgeSec, before finality", async () => {
		rollup.setName(ADDR, "early.eth");
		rollup.mine();
		const game = await propose();
		await sync();
		expect(db.getCommit(game.gameIndex)?.status).toBe("pending"); // too young

		await elapse(MIN_AGE + 1);
		await sync();
		expect(db.getCommit(game.gameIndex)?.status).toBe("valid");
		expect(gateway.commits.map((c) => c.id)).toEqual([game.gameIndex]);
		expect(await verify(early)).toBe("early.eth");
		await expect(verify(finalOnly)).rejects.toThrow(/InvalidGame/); // not finalized
	}, 60_000);

	test("a challenged game stops being accepted", async () => {
		const [commit] = gateway.commits;
		const { proof } = gateway.proveName(ADDR);
		const game = await foundry.attach({ to: (commit as { game: Address }).game, file: "MockOP", contract: "MockDisputeGame" });
		await foundry.confirm(game.challenge());
		await expect(
			l1.readContract({ address: early, abi: RESOLVER_ABI, functionName: "verifyName", args: [ADDR, proof] }),
		).rejects.toThrow(/InvalidGame/);
		await sync();
		expect(db.getCommit(commit.id)?.status).toBe("invalid");
		expect(gateway.commits).toHaveLength(0);
	}, 60_000);

	test("the next unchallenged game takes over; finalization still works", async () => {
		rollup.setName(ADDR, "next.eth");
		rollup.mine();
		const game = await propose();
		await elapse(MIN_AGE + 1);
		await sync();
		expect(await verify(early)).toBe("next.eth");
		await foundry.confirm(asr.finalize(game.address));
		expect(await verify(finalOnly)).toBe("next.eth");
	}, 60_000);
});
