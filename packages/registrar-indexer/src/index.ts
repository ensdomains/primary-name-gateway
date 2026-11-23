import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, OP_MAINNET, redactURL, rpcURL } from "@primary-name-gateway/shared";
import { IndexerDB } from "./db.js";
import { RegistrarIndexer } from "./indexer.js";
import { RPCL2Reader } from "./l2.js";
import { serveIndexer } from "./server.js";

export { IndexerDB } from "./db.js";
export { type IndexerConfig, RegistrarIndexer } from "./indexer.js";
export { type BlockWitness, type L2Reader, type NameChange, RPCL2Reader } from "./l2.js";
export { serveIndexer } from "./server.js";

if (import.meta.main) {
	const env = process.env;
	const deployment = OP_MAINNET;
	const port = Number(env.INDEXER_PORT ?? 8100);
	const pollMs = Number(env.INDEXER_POLL_MS ?? 30_000);
	const dbPath = env.INDEXER_DB ?? `data/${deployment.l2.name}.sqlite`;

	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new IndexerDB(dbPath);
	const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
	log(`L1 ${redactURL(rpcURL(deployment.l1))}`);
	log(`L2 ${redactURL(rpcURL(deployment.l2))}`);
	log(`L2 proofs ${redactURL(rpcURL(deployment.l2, "proof"))}`);
	const indexer = new RegistrarIndexer({
		deployment,
		l1: createClient(deployment.l1),
		l2: new RPCL2Reader(deployment, createClient(deployment.l2), createClient(deployment.l2, "proof"), log),
		db,
		// a game is final ~7 days after creation (3.5d clock + 3.5d airgap); look back further so we start with valid commits
		lookbackSec: Number(env.INDEXER_LOOKBACK_SEC ?? 8 * 86400),
		minFinalAgeSec: Number(env.INDEXER_MIN_FINAL_AGE_SEC ?? 6 * 86400),
		maxAttempts: 5,
		log,
	});
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
