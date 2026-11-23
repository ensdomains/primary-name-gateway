// Offline end-to-end test for Linea (no RPC needed):
//
//   blocksmith (anvil) L1 with a mock LineaRollup (finalizations posted directly)
//   + FakeLineaRollup (in-memory L2: merkle-builder LineaStorage + a world state trie)
//   → registrar-indexer (real, LineaCommitSource, in-memory sqlite, HTTP API)
//   → registrar-gateway (real, SQLite node store, snapshot + patches, multiproofs)
//   → LineaVerifier + L2ReverseResolver deployed on blocksmith
//   → resolve(name, name()) via CCIP-Read
//
// The fake registrar uses the swapped layout (owner at slot 0, names at slot 1) with ownership
// events, to exercise RegistrarLayout end to end. See docs/registrar.md.
//
// Requires `forge` + `anvil` on PATH.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexerDB, LineaCommitSource, RegistrarIndexer, serveIndexer } from "@primary-name-gateway/registrar-indexer";
import { coinTypeFromChainId, type LineaDeployment, type RegistrarLayout } from "@primary-name-gateway/shared";
import { Foundry } from "@adraffy/blocksmith";
import { serveEZCCIP } from "@adraffy/ezccip/serve";
import {
	type Address,
	createPublicClient,
	decodeFunctionResult,
	encodeFunctionData,
	http,
	namehash,
	parseAbi,
	type PublicClient,
	toHex,
} from "viem";
import { packetToBytes } from "viem/ens";
import {
	createEZCCIP,
	type GatewayConfig,
	RegistrarGateway,
	SqlNodeStore,
} from "../packages/registrar-gateway/src/index.js";
import { bunSqliteAdapter } from "../packages/registrar-gateway/src/sqlite.js";
import { FakeLineaRollup } from "./fake-linea.js";

const CHAIN_ID = 59144;
const COIN_TYPE = coinTypeFromChainId(CHAIN_ID);
const MAX_BLOCK_LAG = 10; // L2 blocks a commit may lag behind the latest finalization
const REGISTRAR: Address = "0x0000000000D8e504002cC26E3Ec46D81971C1664";
const LAYOUT: RegistrarLayout = { namesSlot: 1n, ownerSlot: 0n };

const RESOLVER_ABI = parseAbi([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function verifyName(address addr, bytes proof) view returns (string)",
	"function name(bytes32) view returns (string)",
	"error NotFinalized(uint256 l2BlockNumber)",
	"error StaleCommit(uint256 l2BlockNumber, uint256 currentL2BlockNumber)",
	"error InvalidProof()",
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
	huge: "0x8000000000000000000000000000000000000008",
} as const satisfies Record<string, Address>;

describe("offline e2e (linea)", () => {
	let foundry: Foundry;
	let l1: PublicClient;
	let lineaRollup: Awaited<ReturnType<Foundry["deploy"]>>;
	let rollup: FakeLineaRollup;
	let db: IndexerDB;
	let indexer: RegistrarIndexer;
	let indexerServer: ReturnType<typeof serveIndexer>;
	let gateway: RegistrarGateway;
	let gatewayDB: Database;
	let gatewayConfig: GatewayConfig;
	let ccip: Awaited<ReturnType<typeof serveEZCCIP>>;
	let resolver: Address;
	const finalized: number[] = [];

	beforeAll(async () => {
		foundry = await Foundry.launch({ root: `${import.meta.dir}/../packages/contracts`, infoLog: false });
		l1 = createPublicClient({ transport: http(`http://127.0.0.1:${foundry.port}`) });
		lineaRollup = await foundry.deploy({ file: "MockLinea", contract: "MockLineaRollup" });

		rollup = new FakeLineaRollup(REGISTRAR, LAYOUT, [
			"0x00000000000000000000000000000000000000aa",
			"0xffffffffffffffffffffffffffffffffffffff00",
		]);
		const deployment: LineaDeployment = {
			kind: "linea",
			l1: { id: 31337, name: "blocksmith", drpcSlug: "", alchemySlug: "" },
			l2: { id: CHAIN_ID, name: "fake", drpcSlug: "", alchemySlug: "" },
			LineaRollup: lineaRollup.target as Address,
			L2ReverseRegistrar: REGISTRAR,
			layout: LAYOUT,
			registrarCreatedAtBlock: 0,
		};
		db = new IndexerDB(":memory:");
		indexer = new RegistrarIndexer({
			deployment,
			l2: rollup,
			db,
			source: new LineaCommitSource({
				deployment,
				l1,
				l2: rollup,
				lookbackBlocks: 1000,
				maxAttempts: 1,
				blockTag: "latest", // anvil
			}),
		});
		indexerServer = serveIndexer(indexer, db, 0);

		gatewayDB = new Database(":memory:");
		gatewayConfig = { indexerURL: indexerServer.url.origin, keep: 2, marginSec: 0, layout: LAYOUT };
		gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), gatewayConfig);
		ccip = await serveEZCCIP(createEZCCIP(gateway), { log: false });

		const verifier = await foundry.deploy({ file: "LineaVerifier", args: [lineaRollup.target, MAX_BLOCK_LAG] });
		const r = await foundry.deploy({
			file: "L2ReverseResolver",
			args: [verifier.target, REGISTRAR, LAYOUT.namesSlot, COIN_TYPE, [ccip.endpoint]],
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

	// finalize the rollup head on L1
	async function finalize() {
		const { number, stateRoot } = rollup.head;
		await foundry.confirm(lineaRollup.finalize(number, stateRoot));
		finalized.push(number);
		return number;
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
			args: [toHex(packetToBytes(name)), data], // CCIP-Read handled by viem
		});
		return decodeFunctionResult({ abi: RESOLVER_ABI, functionName: "name", data: result });
	}

	function verifyName(addr: Address, id?: number, g = gateway) {
		const { proof } = g.proveName(addr, id);
		return l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [addr, proof] });
	}

	const round1: Record<Address, string> = {
		[A.short]: "raffy.eth",
		[A.long]: `${"long".repeat(20)}.eth`,
		[A.emoji]: "🚀🚀🚀.eth",
		[A.exact31]: `${"x".repeat(27)}.eth`,
		[A.exact32]: `${"y".repeat(28)}.eth`,
		[A.cleared]: "soon-gone.eth",
		[A.huge]: `${"h".repeat(250)}.eth`,
	};

	test("round 1: names resolve after the first finalization", async () => {
		rollup.transferOwnership("0x00000000000000000000000000000000000000AB");
		for (const [addr, name] of Object.entries(round1)) rollup.setName(addr as Address, name);
		rollup.mine();
		const id = await finalize();

		await sync();
		expect(db.getCommit(id)?.status).toBe("valid");
		expect(gateway.commits.map((c) => c.id)).toEqual([id]);

		for (const [addr, name] of Object.entries(round1)) {
			expect(await resolveName(addr as Address)).toBe(name);
		}
		expect(await resolveName(A.never)).toBe("");
		expect(gateway.stats).toMatchObject({ snapshots: 1, patches: 0 });

		const gas = await Promise.all(
			[A.short, A.never, A.long, A.huge].map((addr) =>
				l1.estimateContractGas({
					address: resolver,
					abi: RESOLVER_ABI,
					functionName: "verifyName",
					args: [addr, gateway.proveName(addr).proof],
				}),
			),
		);
		console.log(`verifyName gas: short ${gas[0]}, unset ${gas[1]}, 84 bytes ${gas[2]}, 254 bytes ${gas[3]}`);
	}, 60_000);

	test("round 2: updates and an ownership change are picked up with a patch", async () => {
		rollup.setName(A.short, "raffy2.eth");
		rollup.setName(A.cleared, "");
		rollup.setName(A.long, "now-short.eth");
		rollup.mine();
		rollup.transferOwnership("0x00000000000000000000000000000000000000CD");
		rollup.setName(A.emoji, "🚀.eth");
		rollup.setName(A.emoji, "🚀🚀.eth"); // twice in one block
		rollup.mine(2);
		await finalize();
		await sync();

		expect(gateway.commits.map((c) => c.id)).toEqual(finalized);
		expect(await resolveName(A.short)).toBe("raffy2.eth");
		expect(await resolveName(A.cleared)).toBe("");
		expect(await resolveName(A.long)).toBe("now-short.eth");
		expect(await resolveName(A.emoji)).toBe("🚀🚀.eth");
		expect(await resolveName(A.huge)).toBe(round1[A.huge]);
		expect(gateway.stats).toMatchObject({ snapshots: 1, patches: 1 });

		// the older commit is 3 blocks behind (< MAX_BLOCK_LAG): still accepted
		expect(await verifyName(A.short, finalized[0])).toBe("raffy.eth");
	}, 60_000);

	test("a finalization without an account proof is skipped", async () => {
		rollup.setName(A.short, "unprovable.eth");
		rollup.mine();
		rollup.missingProofs.add(rollup.head.number);
		const id = await finalize();
		await sync();
		expect(db.getCommit(id)).toBeUndefined();
		expect(db.isSkipped(id)).toBeTrue();
		expect(gateway.commits.map((c) => c.id)).not.toContain(id);
		expect(await resolveName(A.short)).toBe("raffy2.eth"); // still the previous commit
	}, 60_000);

	test("round 3: stale commits are rejected once finalization moves past maxBlockLag", async () => {
		rollup.mine(MAX_BLOCK_LAG + 1);
		const id = await finalize();
		await sync();

		const [second] = gateway.commits;
		expect(gateway.commits.map((c) => c.id)).toEqual([finalized[1], id]);
		expect(await resolveName(A.short)).toBe("unprovable.eth");
		await expect(verifyName(A.short, second.id)).rejects.toThrow(/StaleCommit/);
	}, 60_000);

	test("proofs are bound to the address", async () => {
		const { proof } = gateway.proveName(A.emoji);
		await expect(
			l1.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: "verifyName", args: [A.short, proof] }),
		).rejects.toThrow();
	}, 30_000);

	test("a restarted gateway resumes from its store with patches only", async () => {
		const restarted = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(gatewayDB)), gatewayConfig);
		expect(restarted.commits).toEqual(gateway.commits);
		for (const addr of Object.values(A)) {
			expect(restarted.proveName(addr).proof).toBe(gateway.proveName(addr).proof);
		}

		rollup.setName(A.short, "after-restart.eth");
		rollup.setName(A.never, `${"n".repeat(70)}.eth`);
		rollup.setName(A.huge, "");
		rollup.mine();
		const id = await finalize();
		await indexer.tick();
		await restarted.sync();
		expect(restarted.stats).toMatchObject({ snapshots: 0, patches: 1 });
		expect(restarted.commits.at(-1)?.id).toBe(id);
		expect(await verifyName(A.short, undefined, restarted)).toBe("after-restart.eth");
		expect(await verifyName(A.never, undefined, restarted)).toBe(`${"n".repeat(70)}.eth`);
		expect(await verifyName(A.huge, undefined, restarted)).toBe("");
		expect(await verifyName(A.emoji, undefined, restarted)).toBe("🚀🚀.eth");
	}, 60_000);

	test("a restarted indexer rebuilds the same tries from its change log", async () => {
		const reopened = new RegistrarIndexer(indexer.config);
		for (const c of db.getCommits("valid", 2)) {
			expect(reopened.snapshot(c.id, undefined, 1e6)).toEqual(indexer.snapshot(c.id, undefined, 1e6));
		}
		const [b, a] = db.getCommits("valid", 2);
		expect(reopened.patch(a.id, b.id)).toEqual(indexer.patch(a.id, b.id));
	});
});
