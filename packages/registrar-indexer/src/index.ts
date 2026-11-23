import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, DEPLOYMENTS, type Deployment, redactURL, rpcURL } from "@primary-name-gateway/shared";
import { IndexerDB } from "./db.js";
import { type CommitSource, type IndexerConfig, RegistrarIndexer } from "./indexer.js";
import { type ChangeReader, RPCLineaReader, RPCOPReader } from "./l2.js";
import { LineaCommitSource } from "./linea.js";
import { OPCommitSource } from "./op.js";
import { serveIndexer } from "./server.js";

export { IndexerDB } from "./db.js";
export { type CommitSource, type IndexerConfig, NotFinalizedError, RegistrarIndexer } from "./indexer.js";
export {
	type BlockWitness,
	type ChangeReader,
	type L2BlockRef,
	type LineaL2Reader,
	type OPL2Reader,
	type RegistrarChange,
	RPCChangeReader,
	RPCLineaReader,
	RPCOPReader,
} from "./l2.js";
export { LINEA_ROLLUP_ABI, LineaCommitSource, type LineaSourceConfig } from "./linea.js";
export { OPCommitSource, type OPSourceConfig } from "./op.js";
export { serveIndexer } from "./server.js";
export { createIndexerTrie, type IndexerTrie, RowLog } from "./tries.js";

type Log = (...args: unknown[]) => void;

// L2 reader + commit source for a deployment, from env
function createSource(deployment: Deployment, log: Log): { l2: ChangeReader; source: CommitSource } {
	const env = process.env;
	const l1 = createClient(deployment.l1);
	const maxAttempts = Number(env.INDEXER_MAX_ATTEMPTS ?? 5);
	if (deployment.kind === "op") {
		const l2 = new RPCOPReader(deployment, createClient(deployment.l2, "logs"), createClient(deployment.l2, "proof"), log);
		const source = new OPCommitSource({
			deployment,
			l1,
			l2,
			// look back a day past finality so we start with valid commits; don't poll younger games
			lookbackSec: Number(env.INDEXER_LOOKBACK_SEC ?? deployment.gameFinalitySec + 86400),
			minFinalAgeSec: Number(env.INDEXER_MIN_FINAL_AGE_SEC ?? deployment.gameFinalitySec - 86400),
			maxAttempts,
		});
		return { l2, source };
	}
	const l2 = new RPCLineaReader(deployment, createClient(deployment.l2, "logs"), createClient(deployment.l2, "proof"), log);
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
	const dbPath = env.INDEXER_DB ?? `data/${deployment.l2.name}.sqlite`;

	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new IndexerDB(dbPath);
	const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
	log(`${chain}: L1 ${redactURL(rpcURL(deployment.l1))}`);
	log(`${chain}: L2 ${redactURL(rpcURL(deployment.l2))}`);
	log(`${chain}: L2 proofs ${redactURL(rpcURL(deployment.l2, "proof"))}`);
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
