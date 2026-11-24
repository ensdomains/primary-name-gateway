// Offline end-to-end test (no RPC needed):
//
//   blocksmith (anvil) L1 with mock OP fault proof contracts
//   + FakeOPRollup (in-memory L2 with registrar storage)
//   → registrar-indexer (real, in-memory sqlite, HTTP API)
//   → registrar-gateway (real, SQLite node store, synced over HTTP with snapshot + patches, ezccip)
//   → OPFaultVerifier + L2ReverseResolver deployed on blocksmith
//   → resolve(name, name()) via CCIP-Read
//
// Requires `forge` + `anvil` on PATH.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Foundry } from "@adraffy/blocksmith";
import { serveEZCCIP } from "@adraffy/ezccip/serve";
import { trieRows } from "@ensdomains/merkle-builder";
import { IndexerDB, OPCommitSource, RegistrarIndexer, serveIndexer } from "@primary-name-gateway/registrar-indexer";
import {
	coinTypeFromChainId,
	type Deployment,
	type OPDeployment,
	PLAIN_LAYOUT,
	primarySlot,
	type TrieRow,
} from "@primary-name-gateway/shared";
import {
	type Address,
	bytesToHex,
	createPublicClient,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	hexToBigInt,
	http,
	keccak256,
	namehash,
	numberToHex,
	type PublicClient,
	padHex,
	parseAbi,
	stringToHex,
	toHex,
} from "viem";
import { packetToBytes } from "viem/ens";
import {
	createEZCCIP,
	createGatewayHandler,
	type GatewayConfig,
	type gatewayStatus,
	MemoryNodeStore,
	RegistrarGateway,
	SqlNodeStore,
} from "../packages/registrar-gateway/src/index.js";
import { bunSqliteAdapter } from "../packages/registrar-gateway/src/sqlite.js";
import { type FakeBlock, FakeOPRollup } from "./fake-rollup.js";

const CHAIN_ID = 10;
const COIN_TYPE = coinTypeFromChainId(CHAIN_ID);
const GAME_TYPE = 9;
const MAX_SEQUENCE_LAG = 10; // seconds of L2 time a game may lag behind the anchor
const REGISTRAR: Address = "0x0000000000D8e504002cC26E3Ec46D81971C1664";

const RESOLVER_ABI = parseAbi([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function verifyName(address addr, bytes proof) view returns (string)",
	"function name(bytes32) view returns (string)",
	"error InvalidGame(address game)",
	"error StaleGame(uint256 l2SequenceNumber, uint256 anchorSequenceNumber)",
	"error InvalidOutputRoot()",
	"error InvalidStorageProofs()",
]);

const A = {
	short: "0x1000000000000000000000000000000000000001",
	long: "0x2000000000000000000000000000000000000002",
	emoji: "0x3000000000000000000000000000000000000003",
	exact31: "0x4000000000000000000000000000000000000004",
	exact32: "0x5000000000000000000000000000000000000005",
	cleared: "0x6000000000000000000000000000000000000006",
	never: "0x7000000000000000000000000000000000000007",
} as const satisfies Record<string, Address>;

describe("offline e2e", () => {
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
	let gatewayConfig: GatewayConfig;
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

		// another chain in the interop set, to exercise the super root search
		rollup = new FakeOPRollup(CHAIN_ID, REGISTRAR, Math.floor(Date.now() / 1000) - 3600, 2, [
			{ chainId: 8453, outputRoot: keccak256(stringToHex("base")) },
		]);
		const deployment: OPDeployment = {
			kind: "op",
			layout: PLAIN_LAYOUT,
			l1: { id: 31337, name: "blocksmith", drpcSlug: "", alchemySlug: "" },
			l2: { id: CHAIN_ID, name: "fake", drpcSlug: "", alchemySlug: "" },
			AnchorStateRegistry: asr.target as Address,
			L2ReverseRegistrar: REGISTRAR,
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
		gatewayConfig = { indexerURL: indexerServer.url.origin, keepCommits: 2, serveDelaySec: 0 };
		gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), gatewayConfig);
		ccip = await serveEZCCIP(createEZCCIP(gateway), { log: false });

		const verifier = await foundry.deploy({
			file: "OPFaultVerifier",
			args: [asr.target, CHAIN_ID, MAX_SEQUENCE_LAG, 0],
		});
		const r = await foundry.deploy({
			file: "L2ReverseResolver",
			args: [verifier.target, REGISTRAR, 0, COIN_TYPE, [ccip.endpoint]],
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

	// propose a block (default: the rollup head) on L1, optionally lying about the output root
	async function propose({ outputRoot, block = rollup.head }: { outputRoot?: Hex; block?: FakeBlock } = {}) {
		const superRoot = rollup.superRoot(block, outputRoot);
		const gameIndex = Number(await factory.gameCount());
		await foundry.confirm(factory.create(GAME_TYPE, keccak256(superRoot), superRoot, block.timestamp));
		const [, , address] = await factory.gameAtIndex(gameIndex);
		const game = { address: address as Address, gameIndex };
		games.push(game);
		return game;
	}

	async function finalize(game: { address: Address }) {
		await foundry.confirm(asr.finalize(game.address));
	}

	// one indexer tick + one gateway sync (what the two services do on their poll loops)
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
			args: [toHex(packetToBytes(name)), data], // CCIP-Read handled by viem
		});
		return decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "name", data: result });
	}

	function verifyName(addr: Address, gameIndex?: number) {
		const { proof } = gateway.proveName(addr, gameIndex);
		return l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [addr, proof] });
	}

	const round1: Record<Address, string> = {
		[A.short]: "raffy.eth",
		[A.long]: `${"long".repeat(20)}.eth`,
		[A.emoji]: "🚀🚀🚀.eth",
		[A.exact31]: `${"x".repeat(27)}.eth`,
		[A.exact32]: `${"y".repeat(28)}.eth`,
		[A.cleared]: "soon-gone.eth",
	};

	test("round 1: names resolve after the first game is valid", async () => {
		for (const [addr, name] of Object.entries(round1)) rollup.setName(addr as Address, name);
		rollup.mine();
		const game = await propose();

		await sync();
		expect(db.getCommit(game.gameIndex)?.status).toBe("pending");
		expect(gateway.commits).toHaveLength(0); // nothing to serve until the game is valid

		await finalize(game);
		await sync();
		expect(db.getCommit(game.gameIndex)?.status).toBe("valid");
		expect(gateway.commits.map((c) => c.id)).toEqual([game.gameIndex]);

		for (const [addr, name] of Object.entries(round1)) {
			expect(await resolveName(addr as Address)).toBe(name);
		}
		expect(await resolveName(A.never)).toBe("");
		expect(gateway.stats).toMatchObject({ snapshots: 1, patches: 0 });
	}, 60_000);

	test("round 2: updates are picked up incrementally; previous commit still verifies within maxL2SequenceLag", async () => {
		rollup.setName(A.short, "raffy2.eth");
		rollup.setName(A.cleared, "");
		rollup.setName(A.long, "now-short.eth");
		rollup.mine(3); // 6s of L2 time
		const game = await propose();
		await finalize(game);
		await sync();

		expect(gateway.commits.map((c) => c.id)).toEqual(games.map((g) => g.gameIndex));
		expect(await resolveName(A.short)).toBe("raffy2.eth");
		expect(await resolveName(A.cleared)).toBe("");
		expect(await resolveName(A.long)).toBe("now-short.eth");
		expect(await resolveName(A.emoji)).toBe(round1[A.emoji]);

		expect(gateway.stats).toMatchObject({ snapshots: 1, patches: 1 }); // only the diff was downloaded

		// the older held commit is 6s behind the anchor (< MAX_SEQUENCE_LAG): still accepted
		expect(await verifyName(A.short, games[0].gameIndex)).toBe("raffy.eth");
	}, 60_000);

	test("a lying proposal is never served", async () => {
		rollup.setName(A.short, "evil.eth");
		rollup.mine();
		const bad = await propose({ outputRoot: keccak256(stringToHex("lies")) });
		await sync();
		expect(db.getCommit(bad.gameIndex)?.status).toBe("invalid");
		expect(gateway.commits.map((c) => c.id)).not.toContain(bad.gameIndex);
		expect(await resolveName(A.short)).toBe("raffy2.eth");
	}, 60_000);

	test("round 3: stale commits are rejected once the anchor moves past maxL2SequenceLag", async () => {
		rollup.mine(10); // 20s of L2 time
		const game = await propose();
		await finalize(game);
		await sync();

		const [second] = games.filter((g) => db.getCommit(g.gameIndex)?.status === "valid").slice(-2);
		expect(gateway.commits.map((c) => c.id)).toEqual([second.gameIndex, game.gameIndex]);
		expect(await resolveName(A.short)).toBe("evil.eth"); // the honest proposal of the same change

		// the round 2 commit is now > MAX_SEQUENCE_LAG behind the anchor
		await expect(verifyName(A.short, second.gameIndex)).rejects.toThrow(/StaleGame/);
	}, 60_000);

	test("blacklisted games are dropped by the indexer and rejected by the verifier", async () => {
		const latest = games[games.length - 1];
		const { proof } = gateway.proveName(A.short, latest.gameIndex);
		await foundry.confirm(asr.blacklist(latest.address));
		await expect(
			l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [A.short, proof] }),
		).rejects.toThrow(/InvalidGame/);
		await sync();
		expect(db.getCommit(latest.gameIndex)?.status).toBe("invalid");
		expect(gateway.commits.map((c) => c.id)).not.toContain(latest.gameIndex);
	}, 60_000);

	test("proofs are bound to the address", async () => {
		const { proof } = gateway.proveName(A.emoji);
		await expect(
			l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [A.short, proof] }),
		).rejects.toThrow();
	}, 30_000);

	test("the gateway's JSON-RPC answers eth_getProof and eth_getStorageAt as the L2 would; /status", async () => {
		const handler = createGatewayHandler(gateway); // the deployment comes from the indexer
		const call = async (body: unknown): Promise<any> =>
			(await handler(new Request("http://gateway/rpc", { method: "POST", body: JSON.stringify(body) }))).json();
		const commit = gateway.pick();
		const block = rollup.blocks[commit.l2Block];
		const slots = [A.short, A.long, A.never].map((a) => primarySlot(a, 0n));
		const keys = slots.map((s) => bytesToHex(s));
		const { result } = await call({
			jsonrpc: "2.0",
			id: 1,
			method: "eth_getProof",
			params: [REGISTRAR, keys, "latest"],
		});
		// what the L2 itself would answer: its trie (EthStorage.getProof) and its account proof
		expect(result.storageHash).toBe(block.witness.storageHash);
		expect(result.accountProof).toEqual(block.witness.accountProof);
		expect(result.storageProof.map((p: { proof: Hex[] }) => p.proof)).toEqual(
			slots.map((s) => block.storage.getProof(s).proof),
		);
		expect(result.storageProof.map((p: { value: Hex }) => p.value)).toEqual(
			slots.map((s) => {
				const v = block.storage.getStorage(s);
				return numberToHex(v.length ? hexToBigInt(bytesToHex(v)) : 0n);
			}),
		);

		const replies: { result?: Hex; error?: { code: number; message: string } }[] = await call([
			{ jsonrpc: "2.0", id: 1, method: "eth_chainId" },
			{ jsonrpc: "2.0", id: 2, method: "eth_blockNumber" },
			{ jsonrpc: "2.0", id: 3, method: "eth_getStorageAt", params: [REGISTRAR, keys[0], numberToHex(commit.l2Block)] },
			{ jsonrpc: "2.0", id: 4, method: "eth_getStorageAt", params: [A.short, keys[0], "latest"] },
			{ jsonrpc: "2.0", id: 5, method: "eth_getStorageAt", params: [REGISTRAR, keys[0], numberToHex(10_000)] },
			{ jsonrpc: "2.0", id: 6, method: "eth_call", params: [] },
		]);
		expect(replies[0].result).toBe(numberToHex(CHAIN_ID));
		expect(replies[1].result).toBe(numberToHex(commit.l2Block));
		expect(replies[2].result).toBe(padHex(bytesToHex(block.storage.getStorage(slots[0])), { size: 32 }));
		expect(replies[3].error?.message).toContain("only the registrar"); // another account
		expect(replies[4].error?.message).toContain("isn't available"); // a block the gateway doesn't hold
		expect(replies[5].error?.code).toBe(-32601);

		// GET /status
		const status = (await (await handler(new Request("http://gateway/status"))).json()) as ReturnType<
			typeof gatewayStatus
		>;
		expect(status).toMatchObject({
			kind: "op",
			l1ChainId: 31337,
			l2ChainId: CHAIN_ID,
			registrar: REGISTRAR,
			layout: { namesSlot: 0 },
			indexerURL: gatewayConfig.indexerURL,
			keepCommits: 2,
		});
		expect(status.served?.id).toBe(commit.id);
		expect(status.held.map((c: { id: number }) => c.id)).toEqual(gateway.commits.map((c) => c.id));
		expect(status.lastSync?.error).toBeUndefined();
		expect(status.stats.rows).toBeGreaterThan(0);
	}, 30_000);

	test("the deployment comes from the indexer; a store of another deployment starts over", async () => {
		const logs: string[] = [];
		const other = new RegistrarGateway(new MemoryNodeStore(), {
			...gatewayConfig,
			log: (...a: unknown[]) => logs.push(a.join(" ")),
		});
		await other.sync();
		expect(other.info).toMatchObject({ kind: "op", l2ChainId: CHAIN_ID, registrar: REGISTRAR });
		expect(other.stats.snapshots).toBe(1);
		// as if the store had been another chain's
		other.store.setMeta("info", JSON.stringify({ ...other.info, l2ChainId: 1 }));
		await other.sync();
		expect(logs.some((l) => l.includes("the store has a deployment (op commits of L2 1): starting over"))).toBeTrue();
		expect(other.stats.snapshots).toBe(2);
		expect(other.info?.l2ChainId).toBe(CHAIN_ID);
		expect(other.proveName(A.short).proof).toBe(gateway.proveName(A.short).proof);
	}, 30_000);

	test("a restarted gateway resumes from its store with patches only", async () => {
		// same database, new process
		const restarted = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), gatewayConfig);
		expect(restarted.commits).toEqual(gateway.commits);
		for (const addr of Object.values(A)) {
			expect(restarted.proveName(addr).proof).toBe(gateway.proveName(addr).proof);
		}

		rollup.setName(A.short, "after-restart.eth");
		rollup.setName(A.never, `${"n".repeat(70)}.eth`);
		rollup.mine();
		const game = await propose();
		await finalize(game);
		await indexer.tick();
		await restarted.sync();
		expect(restarted.stats).toMatchObject({ snapshots: 0, patches: 1 });
		expect(restarted.commits.at(-1)?.id).toBe(game.gameIndex);
		const verify = (addr: Address) =>
			l1.readContract({
				address: resolver,
				abi: RESOLVER_ABI,
				functionName: "verifyName",
				args: [addr, restarted.proveName(addr).proof],
			});
		expect(await verify(A.short)).toBe("after-restart.eth");
		expect(await verify(A.never)).toBe(`${"n".repeat(70)}.eth`);
		expect(await verify(A.emoji)).toBe(round1[A.emoji]);
	}, 60_000);

	test("a restarted indexer resumes from its stored trie without replaying", async () => {
		expect(Number(db.getState("trieSeq"))).toBe(indexer.changeSeq); // flushed at the last capture
		const restarted = new RegistrarIndexer(indexer.config); // same database, new process
		expect(restarted.changeSeq).toBe(indexer.changeSeq);
		const ids = db.getCommits(undefined, 100).map((c) => c.id);
		expect(ids.length).toBeGreaterThan(1);
		for (const id of ids) {
			expect(restarted.trie.has(id)).toBe(indexer.trie.has(id));
			expect(restarted.snapshot(id, undefined, 1e6)).toEqual(indexer.snapshot(id, undefined, 1e6));
		}
		expect(restarted.patch(ids[1], ids[0])).toEqual(indexer.patch(ids[1], ids[0]));
	}, 30_000);

	test("a game for an older L2 block than synced is rebuilt from the newest trie", async () => {
		rollup.setName(A.short, "older.eth");
		rollup.mine();
		const older = rollup.head;
		rollup.setName(A.short, "newer.eth");
		rollup.setName(A.never, "");
		rollup.setName(A.emoji, `${"e".repeat(40)}.eth`);
		rollup.mine();
		const newer = await propose();
		await finalize(newer);
		await indexer.tick(); // synced past `older`, which was never a commit
		const game = await propose({ block: older });
		await finalize(game);
		await indexer.tick();
		expect(db.getCommit(game.gameIndex)?.status).toBe("valid");
		const rows = (id: number) => indexer.snapshot(id, undefined, 1e6)?.rows;
		expect(rows(game.gameIndex)).toEqual([...trieRows(older.storage.node)]);
		expect(rows(newer.gameIndex)).toEqual([...trieRows(rollup.head.storage.node)]);
		// patches both ways around the rebuilt version
		const table = (r: TrieRow[] = []) => new Map(r.map((x) => [x.path, x.node]));
		const apply = (t: Map<string, Hex | null>, patch: TrieRow[] = []) => {
			for (const r of patch) r.node === null ? t.delete(r.path) : t.set(r.path, r.node);
			return t;
		};
		const [first] = db.getCommits("valid", 100).slice(-1);
		expect(apply(table(rows(first.id)), indexer.patch(first.id, game.gameIndex))).toEqual(table(rows(game.gameIndex)));
		expect(apply(table(rows(game.gameIndex)), indexer.patch(game.gameIndex, newer.gameIndex))).toEqual(
			table(rows(newer.gameIndex)),
		);
		// and it survives a restart
		expect(new RegistrarIndexer(indexer.config).snapshot(game.gameIndex, undefined, 1e6)?.rows).toEqual(
			rows(game.gameIndex),
		);
	}, 60_000);

	test("a game for an L2 block that isn't finalized yet is deferred, without blocking later games", async () => {
		rollup.setName(A.short, "unfinalized.eth");
		rollup.mine();
		const finalized = rollup.blocks[rollup.head.number - 1];
		rollup.finalized = finalized.number;
		const early = await propose(); // the (unfinalized) head
		const late = await propose({ block: finalized }); // created later, for a finalized block
		await indexer.tick();
		expect(db.getCommit(early.gameIndex)).toBeUndefined();
		expect(db.isSkipped(early.gameIndex)).toBeFalse();
		expect(db.getCommit(late.gameIndex)?.l2Block).toBe(finalized.number);
		expect(indexer.syncedBlock).toBeLessThanOrEqual(finalized.number); // nothing unfinal in the change log

		rollup.finalized = undefined;
		await indexer.tick();
		expect(db.getCommit(early.gameIndex)?.status).toBe("pending");
		expect(db.getState("deferredGames")).toBe("[]");
	}, 60_000);

	test("status names both chains, the commit kind, the block time and minAgeSec", () => {
		expect(indexer.status()).toMatchObject({
			l2ChainId: CHAIN_ID,
			l1ChainId: 31337,
			kind: "op",
			l2BlockMs: 2000,
			minAgeSec: 0,
		});
	});

	test("a new indexer catches up on events before its first commit, then rebuilds older games", async () => {
		const fresh = new RegistrarIndexer({ ...indexer.config, db: new IndexerDB(":memory:"), catchUpBlocks: 1 });
		const target = rollup.head.number - 1;
		await fresh.catchUp();
		expect(fresh.syncedBlock).toBe(target);
		expect(fresh.changeSeq).toBe(db.changeSeqAtBlock(target));
		expect(fresh.db.countCommits()).toEqual({ pending: 0, valid: 0, invalid: 0 });
		// the same games: those for blocks at or below the synced head are rebuilt from the newest trie
		await fresh.tick();
		const skipped = (x: IndexerDB) => x.db.query("SELECT id FROM skipped ORDER BY id").all();
		const commits = (x: IndexerDB) => x.getCommits(undefined, 1000).map((c) => [c.id, c.changeSeq]);
		expect(commits(fresh.db).length).toBeGreaterThan(1);
		expect(commits(fresh.db)).toEqual(commits(db));
		expect(skipped(fresh.db)).toEqual(skipped(db));
		fresh.db.close();
	}, 60_000);

	test("an event sync failure is retried without counting against the game", async () => {
		rollup.setName(A.short, "after-sync-error.eth");
		rollup.mine();
		const game = await propose();
		rollup.failChanges = 1;
		await indexer.tick(); // maxAttempts is 1: a counted failure would skip the game
		expect(db.isSkipped(game.gameIndex)).toBeFalse();
		expect(db.getCommit(game.gameIndex)).toBeUndefined();
		await indexer.tick();
		expect(db.getCommit(game.gameIndex)?.status).toBe("pending");
	}, 60_000);

	// last: it leaves `indexer`'s kept tries behind what the database holds
	test("another commit source on the same database sets these games aside; switching back serves them", async () => {
		const [newest] = db.getCommits("valid", 1);
		const rows = indexer.snapshot(newest.id, undefined, 1e6)?.rows;
		expect(rows?.length).toBeGreaterThan(0);
		const count = db.countCommits();

		// the batch inbox source on the same database (it finds nothing here); its retain drops the games' tries
		const other = new RegistrarIndexer({
			...indexer.config,
			deployment: { ...indexer.config.deployment, kind: "inbox" } as unknown as Deployment,
			source: { tick: async () => {} },
		});
		expect(other.status().commits).toEqual({ pending: 0, valid: 0, invalid: 0 });
		await other.tick();

		const back = new RegistrarIndexer(indexer.config);
		expect(back.status().commits).toEqual(count); // nothing lost
		expect(back.trie.has(newest.id)).toBeFalse();
		await back.tick();
		expect(back.trie.has(newest.id)).toBeTrue(); // rebuilt from the newest trie
		expect(back.snapshot(newest.id, undefined, 1e6)?.rows).toEqual(rows);
	}, 60_000);
});
