// bun entry: SQLite-backed gateway (state survives restarts) + ezccip HTTP server
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serveEZCCIP } from "@adraffy/ezccip/serve";
import { DEPLOYMENTS } from "@primary-name-gateway/shared";
import { createEZCCIP, RegistrarGateway, SqlNodeStore } from "./index.js";
import { bunSqliteAdapter } from "./sqlite.js";

const env = process.env;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const chain = env.GATEWAY_CHAIN ?? "optimism";
const deployment = DEPLOYMENTS[chain];
if (!deployment) throw new Error(`unknown GATEWAY_CHAIN: ${chain} (${Object.keys(DEPLOYMENTS).join(", ")})`);
const dbPath = env.GATEWAY_DB ?? `data/gateway-${deployment.l2.name}.sqlite`;
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
const gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(db)), {
	indexerURL: env.INDEXER_URL ?? "http://localhost:8100",
	layout: deployment.layout,
	keep: Number(env.GATEWAY_KEEP ?? 2),
	marginSec: Number(env.GATEWAY_MARGIN_SEC ?? 120),
	log,
});
log(`${chain}: resuming with ${gateway.commits.length} held commits from ${dbPath}`);
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
const ccip = await serveEZCCIP(createEZCCIP(gateway), { port: Number(env.GATEWAY_PORT ?? 8200) });
log(`ccip-read endpoint: ${ccip.endpoint}`);
