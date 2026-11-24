import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	beaconURL,
	createClient,
	createLog,
	DEPLOYMENTS,
	type Deployment,
	redactURL,
	rpcURL,
} from "@primary-name-gateway/shared";
import { ArbitrumCommitSource } from "./arbitrum.js";
import { IndexerDB } from "./db.js";
import { InboxCommitSource } from "./inbox.js";
import { type CommitSource, type IndexerConfig, RegistrarIndexer } from "./indexer.js";
import { KZG } from "./kzg.js";
import { type ChangeReader, RPCInboxReader, RPCLineaReader, RPCOPReader } from "./l2.js";
import { LineaCommitSource } from "./linea.js";
import { lockDatabase } from "./lock.js";
import { OPCommitSource } from "./op.js";
import { n } from "./progress.js";
import { serveIndexer } from "./server.js";

export { ArbitrumCommitSource, type ArbitrumSourceConfig } from "./arbitrum.js";
export { chunkPage, chunkPatch, type NodeSource } from "./chunks.js";
export { IndexerDB } from "./db.js";
export { InboxCommitSource, type InboxSourceConfig, spanBatchParent } from "./inbox.js";
export { type CommitSource, type IndexerConfig, NotFinalizedError, RegistrarIndexer, SyncError } from "./indexer.js";
export { KZG } from "./kzg.js";
export {
	type BlockWitness,
	type ChangeReader,
	type InboxL2Reader,
	isRateLimited,
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
export { lockDatabase } from "./lock.js";
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
			firstScanBlocks: Number(env.INDEXER_INBOX_FIRST_SCAN_BLOCKS ?? 300), // an hour of L1 blocks
			// below the verifier's maxBlockLag (EIP-2935 keeps 8191 block hashes)
			maxBlockLag: Number(env.INDEXER_INBOX_MAX_BLOCK_LAG ?? 7200),
			maxAttempts,
		});
		return { l2, source };
	}
	if (deployment.kind === "arbitrum") {
		const l2 = new RPCInboxReader(
			deployment,
			createClient(deployment.l2, "logs"),
			createClient(deployment.l2, "proof"),
			log,
		);
		const source = new ArbitrumCommitSource({
			deployment,
			l1,
			l2,
			lookbackBlocks: env.INDEXER_LOOKBACK_L1_BLOCKS ? Number(env.INDEXER_LOOKBACK_L1_BLOCKS) : undefined,
			// accept unchallenged assertions this many L1 blocks old; must match the deployed ArbitrumVerifier's minAgeBlocks
			minAgeBlocks: Number(env.INDEXER_MIN_AGE_BLOCKS ?? 0),
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
	const chain = env.INDEXER_CHAIN;
	const deployment = chain && DEPLOYMENTS[chain];
	if (!deployment) {
		console.error(
			`${chain ? `unknown INDEXER_CHAIN: ${chain}` : "set INDEXER_CHAIN"} (${Object.keys(DEPLOYMENTS).join(", ")}), or use bun run indexer:<chain>`,
		);
		process.exit(1);
	}
	const port = Number(env.INDEXER_PORT ?? 8100);
	const pollMs = Number(env.INDEXER_POLL_MS ?? 30_000);
	// one database per L2: base and base-inbox share their events and trie, one indexer at a time
	const dbPath = env.INDEXER_DB ?? `data/${deployment.l2.name}.sqlite`;

	mkdirSync(dirname(dbPath), { recursive: true });
	process.once("exit", lockDatabase(dbPath));
	const db = new IndexerDB(dbPath);
	const log = createLog();
	log(`${chain}: ${deployment.kind} commits, L1 ${deployment.l1.id}, L2 ${deployment.l2.id}, ${dbPath}`);
	const providers: [string, string][] = [
		["L1", rpcURL(deployment.l1)],
		["L2", rpcURL(deployment.l2)],
		["L2 logs", rpcURL(deployment.l2, "logs")],
		["L2 proofs", rpcURL(deployment.l2, "proof")],
	];
	if (deployment.kind === "inbox") providers.push(["L1 beacon", beaconURL(deployment.l1)]);
	for (const [what, url] of providers) {
		if (what === "L2 logs" && url === providers[1][1]) continue; // the same as L2
		log(`  ${what.padEnd(9)} ${redactURL(url)}`);
	}
	const config: IndexerConfig = {
		deployment,
		db,
		log,
		catchUpBlocks: Number(env.INDEXER_CATCHUP_BLOCKS ?? 10_000),
		...createSource(deployment, log),
	};
	const indexer = new RegistrarIndexer(config);
	log(
		indexer.changeSeq
			? `restored ${n(indexer.changeSeq)} changes through L2 block ${n(indexer.syncedBlock)}`
			: `new database: events from L2 block ${n(indexer.syncedBlock + 1)}`,
	);
	const server = serveIndexer(indexer, db, port);
	log(`listening on ${server.url}`);

	let stopped = false;
	// Safe at any await: every write is a transaction, and a restart replays the change log from the
	// last flushed trie.
	const stop = () => {
		stopped = true;
		server.stop();
		db.close();
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	while (!stopped) {
		try {
			await indexer.tick();
		} catch (err) {
			log.error("tick failed:", err);
		}
		await Bun.sleep(pollMs);
	}
}
