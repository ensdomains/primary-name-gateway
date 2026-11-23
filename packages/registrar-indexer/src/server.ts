import type { CommitStatus, SnapshotPage } from "@primary-name-gateway/shared";
import type { IndexerDB } from "./db.js";
import type { RegistrarIndexer } from "./indexer.js";

const MAX_CHANGES = 10000;
const MAX_ROWS = 50000;
const STATUSES = new Set<string>(["pending", "valid", "invalid"]);

// GET /status
// GET /commits?status=valid&limit=2        newest first
// GET /commits/:id
// GET /changes?after=0&until=N&limit=M       registrar events, ordered, (after, until]
// GET /snapshot?commit=ID&after=PATH&limit=N trie rows of a commit, in path order (paged)
// GET /patch?from=A&to=B                     trie rows that turn commit A into commit B
//
// /snapshot and /patch only work for commits the indexer retains (404 otherwise).
// JSON responses over 1 KB are gzipped when the client accepts it (fetch does, and decompresses).
export function serveIndexer(indexer: RegistrarIndexer, db: IndexerDB, port: number) {
	return Bun.serve({
		port,
		routes: {
			"/status": (req) => json(req, indexer.status()),
			"/commits": (req) => {
				const q = new URL(req.url).searchParams;
				const status = q.get("status") ?? undefined;
				if (status && !STATUSES.has(status)) return badRequest("status");
				const limit = clampInt(q.get("limit"), 10, 1, 1000);
				return json(req, db.getCommits(status as CommitStatus | undefined, limit));
			},
			"/commits/:id": (req) => {
				const commit = db.getCommit(Number(req.params.id));
				return commit ? json(req, commit) : notFound();
			},
			"/changes": (req) => {
				const q = new URL(req.url).searchParams;
				const after = clampInt(q.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
				const until = clampInt(q.get("until"), Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
				const limit = clampInt(q.get("limit"), MAX_CHANGES, 1, MAX_CHANGES);
				return json(req, db.getChanges(after, until, limit));
			},
			"/snapshot": (req) => {
				const q = new URL(req.url).searchParams;
				const id = Number(q.get("commit"));
				const after = q.get("after") ?? undefined;
				if (after !== undefined && !/^[0-9a-z]*$/.test(after)) return badRequest("after");
				const limit = clampInt(q.get("limit"), MAX_ROWS, 1, MAX_ROWS);
				const result = indexer.snapshot(id, after, limit);
				if (!result) return notFound();
				const page: SnapshotPage = { id, ...result };
				return json(req, page);
			},
			"/patch": (req) => {
				const q = new URL(req.url).searchParams;
				const rows = indexer.patch(Number(q.get("from")), Number(q.get("to")));
				return rows ? json(req, rows) : notFound();
			},
		},
		fetch: () => notFound(),
	});
}

// gzip level 3: a 10 MB /snapshot page becomes ~4 MB in ~0.1 s (level 6: 3% smaller, 25% slower)
const GZIP_LEVEL = 3;
const GZIP_MIN_BYTES = 1024;

export function json(req: Request, data: unknown): Response {
	const body = JSON.stringify(data);
	const headers: Record<string, string> = { "content-type": "application/json", vary: "accept-encoding" };
	if (body.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
		headers["content-encoding"] = "gzip";
		return new Response(Bun.gzipSync(body, { level: GZIP_LEVEL }), { headers });
	}
	return new Response(body, { headers });
}

function clampInt(s: string | null, def: number, min: number, max: number): number {
	const n = s === null ? def : Number.parseInt(s, 10);
	return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : def;
}

function badRequest(field: string) {
	return new Response(`invalid ${field}`, { status: 400 });
}

function notFound() {
	return new Response("not found", { status: 404 });
}
