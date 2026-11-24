// bun entry: SQLite-backed gateway, served with Bun.serve (createGatewayHandler). The deployment comes from
// the indexer's /status. The store is a cache that survives restarts (so a restart patches instead of
// loading a snapshot); it records the deployment and starts over when the indexer serves another one.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLog, errorLine } from "@primary-name-gateway/shared";
import { createGatewayHandler, RegistrarGateway, SqlNodeStore } from "./index.js";
import { bunSqliteAdapter } from "./sqlite.js";

const env = process.env;
const log = createLog();
const indexerURL = env.INDEXER_URL ?? "http://localhost:8100";
const port = Number(env.GATEWAY_PORT ?? 8200);
const pollMs = Number(env.GATEWAY_POLL_MS ?? 30_000);
let timer: ReturnType<typeof setTimeout> | undefined;

// one store per gateway: named by port, so gateways side by side (base and base-inbox) never share one
const dbPath = env.GATEWAY_DB ?? `data/gateway-${port}.sqlite`;
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
const gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(db)), {
	indexerURL,
	keepCommits: Number(env.GATEWAY_KEEP_COMMITS ?? 2),
	serveDelaySec: Number(env.GATEWAY_SERVE_DELAY_SEC ?? 0),
	log,
});
const held = gateway.commits.length;
const info = gateway.info;
log(`${dbPath}: ${held ? `resuming with ${held} held commits${info?.chain ? ` of ${info.chain}` : ""}` : "empty"}`);

// A signal is handled at an await, so a sync step's writes (rows, then the head or the snapshot cursor)
// are never split. Every write is a transaction, so a hard kill is safe too: it can redo a snapshot.
// A second Ctrl-C kills it at once.
const stop = async (signal: string) => {
	log(`${signal}: stopping`);
	clearTimeout(timer);
	await server.stop(true);
	db.close();
	process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// listening first: /status answers during the first sync, and CCIP-Read / JSON-RPC say there's no commit
// yet until one is held
const server = Bun.serve({ port, fetch: createGatewayHandler(gateway, { log: true }) });
log("listening:");
log(`  CCIP-Read  ${server.url}`);
log(`  JSON-RPC   ${server.url}rpc`);
log(`  status     ${server.url}status`);
log(`syncing from the indexer at ${indexerURL}, every ${pollMs / 1000}s`);

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
		log.error(`sync failed: ${errorLine(err)}`);
	}
	timer = setTimeout(poll, pollMs);
};
await poll();
