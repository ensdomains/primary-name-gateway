// bun entry: SQLite-backed gateway (state survives restarts) + ezccip HTTP server
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLog, DEPLOYMENTS } from "@primary-name-gateway/shared";
import { createGatewayHandler, RegistrarGateway, SqlNodeStore } from "./index.js";
import { bunSqliteAdapter } from "./sqlite.js";

const env = process.env;
const log = createLog();
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
	keepCommits: Number(env.GATEWAY_KEEP_COMMITS ?? 2),
	serveDelaySec: Number(env.GATEWAY_SERVE_DELAY_SEC ?? 0),
	log,
});
const held = gateway.commits.length;
log(
	`${chain}: ${deployment.kind} commits, L1 ${deployment.l1.id}, L2 ${deployment.l2.id}, ${dbPath} (${held ? `resuming with ${held} held commits` : "empty"})`,
);
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

// listening first: /status answers during the first sync, and CCIP-Read / JSON-RPC say there's no
// commit yet until one is held
server = Bun.serve({
	port: Number(env.GATEWAY_PORT ?? 8200),
	fetch: createGatewayHandler(
		gateway,
		{
			kind: deployment.kind,
			l1ChainId: deployment.l1.id,
			l2ChainId: deployment.l2.id,
			registrar: deployment.L2ReverseRegistrar,
		},
		{ log: true },
	),
});
log(`listening: CCIP-Read ${server.url}, JSON-RPC ${server.url}rpc, status ${server.url}status`);
log(`syncing from the indexer at ${gateway.config.indexerURL}, every ${pollMs / 1000}s`);

let ready = false;
const poll = async () => {
	try {
		await gateway.sync();
		if (!ready && gateway.commits.length) {
			ready = true;
			const c = gateway.pick();
			log.ok(`ready: serving commit ${c.id} (L2 block ${c.l2Block})`);
		}
	} catch (err) {
		log.error("sync failed:", err);
	}
	timer = setTimeout(poll, pollMs);
};
await poll();
