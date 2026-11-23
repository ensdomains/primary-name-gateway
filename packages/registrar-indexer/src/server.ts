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
// /snapshot and /patch only work for commits the indexer retains (404 otherwise)
export function serveIndexer(indexer: RegistrarIndexer, db: IndexerDB, port: number) {
	return Bun.serve({
		port,
		routes: {
			"/status": () => Response.json(indexer.status()),
			"/commits": (req) => {
				const q = new URL(req.url).searchParams;
				const status = q.get("status") ?? undefined;
				if (status && !STATUSES.has(status)) return badRequest("status");
				const limit = clampInt(q.get("limit"), 10, 1, 1000);
				return Response.json(db.getCommits(status as CommitStatus | undefined, limit));
			},
			"/commits/:id": (req) => {
				const commit = db.getCommit(Number(req.params.id));
				return commit ? Response.json(commit) : notFound();
			},
			"/changes": (req) => {
				const q = new URL(req.url).searchParams;
				const after = clampInt(q.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
				const until = clampInt(q.get("until"), Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
				const limit = clampInt(q.get("limit"), MAX_CHANGES, 1, MAX_CHANGES);
				return Response.json(db.getChanges(after, until, limit));
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
				return Response.json(page);
			},
			"/patch": (req) => {
				const q = new URL(req.url).searchParams;
				const rows = indexer.patch(Number(q.get("from")), Number(q.get("to")));
				return rows ? Response.json(rows) : notFound();
			},
		},
		fetch: () => notFound(),
	});
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
