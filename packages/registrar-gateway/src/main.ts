// bun entry: SQLite-backed gateway (state survives restarts), served with Bun.serve (createGatewayHandler).
// The deployment comes from the indexer's /status.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLog, errorLine, type IndexerStatus } from "@primary-name-gateway/shared";
import { createGatewayHandler, RegistrarGateway, SqlNodeStore } from "./index.js";
import { bunSqliteAdapter } from "./sqlite.js";

const env = process.env;
const log = createLog();
const indexerURL = env.INDEXER_URL ?? "http://localhost:8100";
const pollMs = Number(env.GATEWAY_POLL_MS ?? 30_000);
const startedAt = Math.floor(Date.now() / 1000);
let db: Database | undefined;
let handler: ((request: Request) => Promise<Response>) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

// A signal is handled at an await, so a sync step's writes (rows, then the head or the snapshot cursor)
// are never split. Every write is a transaction, so a hard kill is safe too: it can redo a snapshot.
// A second Ctrl-C kills it at once.
const stop = async (signal: string) => {
	log(`${signal}: stopping`);
	clearTimeout(timer);
	await server.stop(true);
	db?.close();
	process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// listening first: /status answers while it waits for the indexer and during the first sync, and
// CCIP-Read / JSON-RPC say there's no commit yet until one is held
const server = Bun.serve({
	port: Number(env.GATEWAY_PORT ?? 8200),
	fetch: (request) => handler?.(request) ?? waiting(request),
});
log("listening:");
log(`  CCIP-Read  ${server.url}`);
log(`  JSON-RPC   ${server.url}rpc`);
log(`  status     ${server.url}status`);

// before the store is open
async function waiting(request: Request): Promise<Response> {
	if (new URL(request.url).pathname === "/status") {
		return Response.json({ indexerURL, waiting: "for the indexer", startedAt });
	}
	return new Response("starting: waiting for the indexer", { status: 503 });
}

// the indexer's /status, retried until it answers
async function indexerStatus(): Promise<IndexerStatus> {
	for (let warned = false; ; warned = true) {
		try {
			const res = await fetch(`${indexerURL}/status`);
			if (!res.ok) throw new Error(`/status: ${res.status}`);
			return (await res.json()) as IndexerStatus;
		} catch (err) {
			if (!warned) log.warn(`waiting for the indexer at ${indexerURL}: ${errorLine(err)}`);
			await Bun.sleep(5000);
		}
	}
}

// The store is named after the indexer's deployment, so the indexer has to answer first. One store per
// deployment: base and base-inbox gateways hold different commits (and can run side by side).
const status = await indexerStatus();
const dbPath = env.GATEWAY_DB ?? `data/gateway-${status.chain ?? `${status.kind}-${status.l2ChainId}`}.sqlite`;
mkdirSync(dirname(dbPath), { recursive: true });
db = new Database(dbPath, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
const gateway = new RegistrarGateway(new SqlNodeStore(bunSqliteAdapter(db)), {
	indexerURL,
	keepCommits: Number(env.GATEWAY_KEEP_COMMITS ?? 2),
	serveDelaySec: Number(env.GATEWAY_SERVE_DELAY_SEC ?? 0),
	log,
});
handler = createGatewayHandler(gateway, { log: true });
const held = gateway.commits.length;
log(`${dbPath} (${held ? `resuming with ${held} held commits` : "empty"})`);
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
