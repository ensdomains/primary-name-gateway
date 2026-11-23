import { type CommitStatus, diffRows, type SnapshotPage, type TrieRow, trieRows } from "@primary-name-gateway/shared";
import type { IndexerDB } from "./db.js";
import type { RegistrarIndexer } from "./indexer.js";

const MAX_CHANGES = 10000;
const MAX_ROWS = 50000;
const STATUSES = new Set<string>(["pending", "valid", "invalid"]);

// GET /status
// GET /commits?status=valid&limit=2        newest first
// GET /commits/:gameIndex
// GET /changes?after=0&until=N&limit=M     name changes, ordered, (after, until]
// GET /snapshot?game=G&after=PATH&limit=N  trie rows of a commit, in path order (paged)
// GET /patch?from=A&to=B                   trie rows that turn commit A into commit B
//
// /snapshot and /patch only work for commits the indexer retains (404 otherwise)
export function serveIndexer(indexer: RegistrarIndexer, db: IndexerDB, port: number) {
	const patches = new Map<string, TrieRow[]>(); // small LRU: gateways ask for the same patch
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
			"/commits/:gameIndex": (req) => {
				const commit = db.getCommit(Number(req.params.gameIndex));
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
				const gameIndex = Number(q.get("game"));
				const root = indexer.rootOf(gameIndex);
				if (!root) return notFound();
				const after = q.get("after") ?? undefined;
				if (after !== undefined && !/^[0-9a-f]*$/.test(after)) return badRequest("after");
				const limit = clampInt(q.get("limit"), MAX_ROWS, 1, MAX_ROWS);
				const rows: TrieRow[] = [];
				for (const row of trieRows(root.node, after)) {
					rows.push(row);
					if (rows.length === limit) break;
				}
				const page: SnapshotPage = {
					gameIndex,
					rows,
					next: rows.length === limit ? rows[rows.length - 1].path : null,
				};
				return Response.json(page);
			},
			"/patch": (req) => {
				const q = new URL(req.url).searchParams;
				const from = Number(q.get("from"));
				const to = Number(q.get("to"));
				const key = `${from}:${to}`;
				let rows = patches.get(key);
				if (!rows) {
					const a = indexer.rootOf(from);
					const b = indexer.rootOf(to);
					if (!a || !b) return notFound();
					rows = diffRows(a.node, b.node);
					patches.set(key, rows);
					if (patches.size > 16) patches.delete(patches.keys().next().value!);
				}
				return Response.json(rows);
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
