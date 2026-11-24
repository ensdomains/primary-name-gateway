// bun entry: SQLite-backed gateway (state survives restarts) + ezccip HTTP server
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEPLOYMENTS } from "@primary-name-gateway/shared";
import { createGatewayHandler, RegistrarGateway, SqlNodeStore } from "./index.js";
import { bunSqliteAdapter } from "./sqlite.js";

const env = process.env;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const chain = env.GATEWAY_CHAIN;
const deployment = chain && DEPLOYMENTS[chain];
if (!deployment) {
	console.error(
		`${chain ? `unknown GATEWAY_CHAIN: ${chain}` : "set GATEWAY_CHAIN"} (${Object.keys(DEPLOYMENTS).join(", ")}), or use bun run gateway:<chain>`,
	);
	process.exit(1);
}
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
let timer: ReturnType<typeof setTimeout> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

// A signal is handled at an await, so a sync step's writes (rows, then the head or the snapshot cursor)
// are never split. Every write is a transaction, so a hard kill is safe too: it can redo a snapshot.
// A second Ctrl-C kills it at once.
const stop = async (signal: string) => {
	log(`${signal}: stopping`);
	clearTimeout(timer);
	await server?.stop(true);
	db.close();
	process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const poll = async () => {
	try {
		await gateway.sync();
	} catch (err) {
		log("sync failed:", err);
	}
	timer = setTimeout(poll, pollMs);
};
await poll();
server = Bun.serve({
	port: Number(env.GATEWAY_PORT ?? 8200),
	fetch: createGatewayHandler(
		gateway,
		{ chainId: deployment.l2.id, registrar: deployment.L2ReverseRegistrar },
		{ log: true },
	),
});
log(`CCIP-Read: ${server.url}, JSON-RPC: ${server.url}rpc`);
