// bun entry: SQLite-backed gateway (state survives restarts) + ezccip HTTP server
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@namestone/ezccip/serve";
import { createEZCCIP, RegistrarGateway, SqlNodeStore } from "./index.js";
import { bunSqliteAdapter } from "./sqlite.js";

const env = process.env;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const dbPath = env.GATEWAY_DB ?? "data/gateway-optimism.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
const gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(db)), {
	indexerURL: env.INDEXER_URL ?? "http://localhost:8100",
	keep: Number(env.GATEWAY_KEEP ?? 2),
	marginSec: Number(env.GATEWAY_MARGIN_SEC ?? 120),
	log,
});
log(`resuming with ${gateway.commits.length} held commits from ${dbPath}`);
const pollMs = Number(env.GATEWAY_POLL_MS ?? 30_000);
const poll = async () => {
	try {
		await gateway.sync();
	} catch (err) {
		log("sync failed:", err);
	}
	setTimeout(poll, pollMs);
};
await poll();
const ccip = await serve(createEZCCIP(gateway), {
	port: Number(env.GATEWAY_PORT ?? 8200),
	protocol: "raw",
	log,
});
log(`ccip-read endpoint: ${ccip.endpoint}`);
