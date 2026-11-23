import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { beaconURL, createClient, DEPLOYMENTS, type Deployment, redactURL, rpcURL } from "@primary-name-gateway/shared";
import { IndexerDB } from "./db.js";
import { InboxCommitSource } from "./inbox.js";
import { type CommitSource, type IndexerConfig, RegistrarIndexer } from "./indexer.js";
import { KZG } from "./kzg.js";
import { type ChangeReader, RPCInboxReader, RPCLineaReader, RPCOPReader } from "./l2.js";
import { LineaCommitSource } from "./linea.js";
import { OPCommitSource } from "./op.js";
import { serveIndexer } from "./server.js";

export { IndexerDB } from "./db.js";
export { InboxCommitSource, type InboxSourceConfig } from "./inbox.js";
export { type CommitSource, type IndexerConfig, NotFinalizedError, RegistrarIndexer, SyncError } from "./indexer.js";
export { KZG } from "./kzg.js";
export {
	type BlockWitness,
	type ChangeReader,
	type InboxL2Reader,
	type L2BlockRef,
	type LineaL2Reader,
	type OPL2Reader,
	type RegistrarChange,
	RPCChangeReader,
	RPCInboxReader,
	RPCLineaReader,
	RPCOPReader,
} from "./l2.js";
export { LINEA_ROLLUP_ABI, LineaCommitSource, type LineaSourceConfig } from "./linea.js";
export { OPCommitSource, type OPSourceConfig } from "./op.js";
export { serveIndexer } from "./server.js";
export { KeptVersions, SqlRowLog } from "./sql-row-log.js";
export { createIndexerTrie, type IndexerTrie, MPTIndexerTrie, RowLog } from "./tries.js";

type Log = (...args: unknown[]) => void;

// L2 reader + commit source for a deployment, from env
function createSource(deployment: Deployment, log: Log): { l2: ChangeReader; source: CommitSource } {
	const env = process.env;
	const l1 = createClient(deployment.l1);
	const maxAttempts = Number(env.INDEXER_MAX_ATTEMPTS ?? 5);
	if (deployment.kind === "op") {
		const l2 = new RPCOPReader(
			deployment,
			createClient(deployment.l2, "logs"),
			createClient(deployment.l2, "proof"),
			log,
		);
		const source = new OPCommitSource({
			deployment,
			l1,
			l2,
			// look back a day past finality so we start with valid commits; don't poll younger games
			lookbackSec: Number(env.INDEXER_LOOKBACK_SEC ?? deployment.gameFinalitySec + 86400),
			minFinalAgeSec: Number(env.INDEXER_MIN_FINAL_AGE_SEC ?? deployment.gameFinalitySec - 86400),
			maxAttempts,
			// accept unchallenged games this old before finality; must match the deployed OPFaultVerifier's minAgeSec
			minAgeSec: Number(env.INDEXER_MIN_AGE_SEC ?? 0),
		});
		return { l2, source };
	}
	if (deployment.kind === "inbox") {
		const l2 = new RPCInboxReader(
			deployment,
			createClient(deployment.l2, "logs"),
			createClient(deployment.l2, "proof"),
			log,
		);
		let kzg: Promise<KZG> | undefined;
		const source = new InboxCommitSource({
			deployment,
			l1,
			l2,
			beaconURL: beaconURL(deployment.l1),
			kzg: () => {
				kzg ??= KZG.load(env.KZG_TRUSTED_SETUP);
				return kzg;
			},
			intervalSec: Number(env.INDEXER_INBOX_INTERVAL_SEC ?? 600),
			scanBlocks: Number(env.INDEXER_INBOX_SCAN_BLOCKS ?? 64),
			// below the verifier's maxBlockLag (EIP-2935 keeps 8191 block hashes)
			maxBlockLag: Number(env.INDEXER_INBOX_MAX_BLOCK_LAG ?? 7200),
			maxAttempts,
		});
		return { l2, source };
	}
	const l2 = new RPCLineaReader(
		deployment,
		createClient(deployment.l2, "logs"),
		createClient(deployment.l2, "proof"),
		log,
	);
	const source = new LineaCommitSource({
		deployment,
		l1,
		l2,
		// finalizations come every few hours; Shomei keeps proofs for about a day
		lookbackBlocks: Number(env.INDEXER_LOOKBACK_L1_BLOCKS ?? 3600),
		maxAttempts,
	});
	return { l2, source };
}

if (import.meta.main) {
	const env = process.env;
	const chain = env.INDEXER_CHAIN ?? "optimism";
	const deployment = DEPLOYMENTS[chain];
	if (!deployment) throw new Error(`unknown INDEXER_CHAIN: ${chain} (${Object.keys(DEPLOYMENTS).join(", ")})`);
	const port = Number(env.INDEXER_PORT ?? 8100);
	const pollMs = Number(env.INDEXER_POLL_MS ?? 30_000);
	const dbPath = env.INDEXER_DB ?? `data/${chain}.sqlite`;

	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new IndexerDB(dbPath);
	const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
	log(`${chain}: L1 ${redactURL(rpcURL(deployment.l1))}`);
	log(`${chain}: L2 ${redactURL(rpcURL(deployment.l2))}`);
	log(`${chain}: L2 proofs ${redactURL(rpcURL(deployment.l2, "proof"))}`);
	if (deployment.kind === "inbox") log(`${chain}: L1 beacon ${redactURL(beaconURL(deployment.l1))}`);
	const config: IndexerConfig = { deployment, db, log, ...createSource(deployment, log) };
	const indexer = new RegistrarIndexer(config);
	log(`restored ${indexer.changeSeq} changes through L2 block ${indexer.syncedBlock}`);
	const server = serveIndexer(indexer, db, port);
	log(`listening on ${server.url}`);

	let stopped = false;
	process.once("SIGINT", () => {
		stopped = true;
		server.stop();
		db.close();
		process.exit(0);
	});
	while (!stopped) {
		try {
			await indexer.tick();
		} catch (err) {
			log("tick failed:", err);
		}
		await Bun.sleep(pollMs);
	}
}
