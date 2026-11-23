import type { Database } from "bun:sqlite";
import type { SqlAdapter } from "./store.js";

export function bunSqliteAdapter(db: Database): SqlAdapter {
	return {
		exec: (query, ...params) => db.query(query).all(...params) as Record<string, unknown>[],
		transaction: (fn) => db.transaction(fn)(),
	};
}
