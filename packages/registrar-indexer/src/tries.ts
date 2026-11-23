import { EthRowStorage } from "@ensdomains/merkle-builder";
import {
	applyChange,
	type Change,
	type CommitKind,
	LineaStorageTrie,
	type RegistrarLayout,
	rootHash,
	type TrieRow,
} from "@primary-name-gateway/shared";
import type { Hex } from "viem";
import type { IndexerDB } from "./db.js";
import { KeptVersions, SqlRowLog } from "./sql-row-log.js";

export type RowPage = { rows: TrieRow[]; next: string | null };
export type CommitRef = { id: number; l2Block: number; changeSeq: number };

// The registrar's storage trie as the indexer sees it: changes go in (in chain order),
// and the tries of retained commits come out as rows (snapshots) or row diffs (patches).
export interface IndexerTrie {
	readonly seq: number; // last applied change: a persistent trie resumes after it
	apply(change: Change): void;
	storageHash(): Hex; // after every applied change
	// storage hash of an older commit (changeSeq < seq), rebuilt if needed; throws if unsupported
	storageHashAt(commit: CommitRef): Hex;
	capture(commit: CommitRef): void; // keep the trie of this commit (the current one, or one storageHashAt computed)
	retain(ids: Set<number>): void; // forget other commits
	has(id: number): boolean;
	snapshot(id: number, after: string | undefined, limit: number): RowPage | undefined;
	patch(from: number, to: number): TrieRow[] | undefined;
}

export function createIndexerTrie(kind: CommitKind, layout: RegistrarLayout, db: IndexerDB): IndexerTrie {
	return kind === "linea" ? new LineaIndexerTrie(layout) : new MPTIndexerTrie(layout, db);
}

function page(rows: Iterable<TrieRow>, limit: number): RowPage {
	const out: TrieRow[] = [];
	for (const row of rows) {
		out.push(row);
		if (out.length === limit) break;
	}
	return { rows: out, next: out.length === limit ? out[out.length - 1].path : null };
}

// rows are at hashed (random) paths, so every flush rewrites pages all over the table:
// fewer, larger flushes share pages (memory: the nodes on the touched paths)
const FLUSH_CHANGES = Math.max(1, Number(process.env.INDEXER_FLUSH_CHANGES) || 50_000);

// Merkle-Patricia (OP Stack): the trie lives in the indexer's database as versioned rows
// (version = change seq), so memory doesn't grow with it and a restart resumes where it stopped.
// Changes are applied to an EthRowStorage and written out every FLUSH_CHANGES and at each capture.
export class MPTIndexerTrie implements IndexerTrie {
	private readonly log: SqlRowLog;
	private readonly storage: EthRowStorage;
	private readonly versions: Map<number, number>; // commit id => change seq
	private pending = 0;
	private restoring?: { seq: number; head: number; rows: TrieRow[] }; // from storageHashAt, for capture
	seq: number;

	constructor(
		readonly layout: RegistrarLayout,
		readonly db: IndexerDB,
	) {
		this.log = new SqlRowLog(db.db);
		this.storage = new EthRowStorage((path) => this.log.head(path));
		this.seq = Number(db.getState("trieSeq") ?? 0);
		this.versions = new Map(JSON.parse(db.getState("trieCommits") ?? "[]"));
		this.log.kept.set(this.versions.values());
	}

	private flush() {
		if (!this.pending) return;
		const { rows } = this.storage.commit();
		this.db.db.transaction(() => {
			this.log.put(this.seq, rows);
			this.db.setState("trieSeq", this.seq);
		})();
		this.pending = 0;
	}

	private saveVersions() {
		this.db.db.transaction(() => {
			this.log.keep(this.versions.values());
			this.db.setState("trieCommits", JSON.stringify([...this.versions]));
		})();
	}

	apply(change: Change) {
		if (change.seq <= this.seq) throw new Error(`change ${change.seq} is already applied (${this.seq})`);
		applyChange(this.storage, this.layout, change);
		this.seq = change.seq;
		if (++this.pending >= FLUSH_CHANGES) this.flush();
	}
	storageHash(): Hex {
		return this.storage.storageHash;
	}
	storageHashAt({ changeSeq }: CommitRef): Hex {
		if (changeSeq === this.seq) return this.storageHash();
		if (this.log.kept.has(changeSeq)) return rootHash(this.log.get("", changeSeq));
		// not kept (merged into newer entries): start from the newest trie and set every key
		// written since back to its value then
		this.flush();
		const storage = new EthRowStorage((path) => this.log.head(path));
		for (const c of this.db.revertChanges(changeSeq)) applyChange(storage, this.layout, c);
		const { rows, storageHash } = storage.commit();
		this.restoring = { seq: changeSeq, head: this.seq, rows };
		return storageHash;
	}
	capture({ id, changeSeq }: CommitRef) {
		const restoring = this.restoring;
		this.restoring = undefined;
		if (changeSeq === this.seq) this.flush();
		this.db.db.transaction(() => {
			if (!this.log.kept.has(changeSeq) && changeSeq !== this.seq) {
				if (restoring?.seq !== changeSeq || restoring.head !== this.seq) {
					throw new Error(`commit ${id}: change ${changeSeq} is not available (call storageHashAt first)`);
				}
				this.log.restore(changeSeq, restoring.rows);
			}
			this.versions.set(id, changeSeq);
			this.saveVersions();
		})();
	}
	retain(ids: Set<number>) {
		const n = this.versions.size;
		for (const id of this.versions.keys()) if (!ids.has(id)) this.versions.delete(id);
		if (this.versions.size !== n) this.saveVersions();
	}
	has(id: number) {
		return this.versions.has(id);
	}
	snapshot(id: number, after: string | undefined, limit: number): RowPage | undefined {
		const v = this.versions.get(id);
		if (v === undefined) return;
		return page(this.log.rowsAt(v, after, limit), limit);
	}
	patch(from: number, to: number): TrieRow[] | undefined {
		const a = this.versions.get(from);
		const b = this.versions.get(to);
		if (a === undefined || b === undefined) return;
		if (a > b) throw new Error(`patch ${from} => ${to}: backwards`);
		return this.log.changed(a, b);
	}
}

// Linea: the trie is mutable, so its rows are logged per L2 block and a commit is a version.
// Changes within one block are buffered and applied together (Shomei's per-block semantics).
export class LineaIndexerTrie implements IndexerTrie {
	private readonly storage = new LineaStorageTrie();
	private readonly log = new RowLog();
	private readonly versions = new Map<number, number>(); // commit id => L2 block
	private block = -1; // block of the buffered changes
	seq = 0;

	constructor(readonly layout: RegistrarLayout) {
		this.log.put(0, this.storage.commit()); // the empty trie (sentinels)
	}

	private endBlock() {
		if (this.storage.hasPending) this.log.put(this.block, this.storage.commit());
	}

	apply(change: Change) {
		if (change.block !== this.block) {
			this.endBlock();
			this.block = change.block;
		}
		applyChange(this.storage, this.layout, change);
		this.seq = change.seq;
	}
	storageHash(): Hex {
		this.endBlock();
		return this.storage.storageRoot;
	}
	storageHashAt({ id }: CommitRef): Hex {
		throw new Error(`commit ${id}: out of order (Linea commits are processed in block order)`);
	}
	capture({ id, l2Block }: CommitRef) {
		this.endBlock();
		if (l2Block < this.block) throw new Error(`commit ${id}: block ${l2Block} is before applied changes`);
		this.versions.set(id, l2Block);
		this.log.keep(this.versions.values());
	}
	retain(ids: Set<number>) {
		for (const id of this.versions.keys()) if (!ids.has(id)) this.versions.delete(id);
		this.log.keep(this.versions.values());
	}
	has(id: number) {
		return this.versions.has(id);
	}
	snapshot(id: number, after: string | undefined, limit: number): RowPage | undefined {
		const v = this.versions.get(id);
		if (v === undefined) return;
		return page(this.log.rowsAt(v, after), limit);
	}
	patch(from: number, to: number): TrieRow[] | undefined {
		const a = this.versions.get(from);
		const b = this.versions.get(to);
		if (a === undefined || b === undefined) return;
		return this.log.changed(a, b);
	}
}

type Entry = { v: number; node: Hex | null };

// Rows by version, keeping only what the kept versions (and the newest state) need.
export class RowLog {
	private readonly rows = new Map<string, Entry[]>(); // ascending by version
	private readonly kept = new KeptVersions();
	private sorted: string[] | undefined; // path order cache

	keep(versions: Iterable<number>) {
		this.kept.set(versions);
		this.prune();
	}

	put(v: number, rows: TrieRow[]) {
		for (const { path, node } of rows) {
			const entries = this.rows.get(path);
			if (!entries) {
				if (node === null) continue;
				this.rows.set(path, [{ v, node }]);
				this.sorted = undefined;
				continue;
			}
			const last = entries[entries.length - 1];
			if (last.v > v) throw new Error(`version ${v} is older than ${last.v}`);
			if (last.v !== v && this.kept.needed(last.v, v)) {
				entries.push({ v, node });
			} else {
				last.v = v;
				last.node = node;
			}
			if (entries.length === 1 && entries[0].node === null) {
				this.rows.delete(path);
				this.sorted = undefined;
			}
		}
	}

	private prune() {
		for (const [path, entries] of this.rows) {
			const kept = entries.filter((e, i) => i === entries.length - 1 || this.kept.needed(e.v, entries[i + 1].v));
			while (kept.length && kept[0].node === null) kept.shift(); // reads the same as no entry
			if (kept.length) {
				this.rows.set(path, kept);
			} else {
				this.rows.delete(path);
				this.sorted = undefined;
			}
		}
	}

	private at(entries: Entry[], v: number): Hex | null {
		for (let i = entries.length - 1; i >= 0; i--) if (entries[i].v <= v) return entries[i].node;
		return null;
	}

	// rows of version v in path order, after `after`
	*rowsAt(v: number, after?: string): Generator<TrieRow> {
		this.sorted ??= [...this.rows.keys()].sort();
		let lo = 0;
		if (after !== undefined) {
			let hi = this.sorted.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (this.sorted[mid] <= after) lo = mid + 1;
				else hi = mid;
			}
		}
		for (let i = lo; i < this.sorted.length; i++) {
			const path = this.sorted[i];
			const node = this.at(this.rows.get(path)!, v);
			if (node !== null) yield { path, node };
		}
	}

	// rows that turn version a into version b
	changed(a: number, b: number): TrieRow[] {
		const out: TrieRow[] = [];
		for (const [path, entries] of this.rows) {
			if (entries.some((e) => e.v > a && e.v <= b)) out.push({ path, node: this.at(entries, b) });
		}
		return out;
	}
}
