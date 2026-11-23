import { EthStorage, type MaybeNode } from "@ensdomains/merkle-builder";
import {
	applyChange,
	type Change,
	type CommitKind,
	diffRows,
	LineaStorageTrie,
	type RegistrarLayout,
	type TrieRow,
	trieRows,
} from "@primary-name-gateway/shared";
import type { Hex } from "viem";

export type RowPage = { rows: TrieRow[]; next: string | null };

// The registrar's storage trie as the indexer sees it: changes go in (in chain order),
// and the tries of retained commits come out as rows (snapshots) or row diffs (patches).
export interface IndexerTrie {
	apply(change: Change): void;
	storageHash(): Hex; // after every applied change
	capture(id: number, l2Block: number): void; // the current trie is commit `id`
	// rebuild an older trie from its changes and capture it (returns its storage hash)
	captureFrom(id: number, l2Block: number, changes: Iterable<Change>): Hex;
	retain(ids: Set<number>): void; // forget other commits
	has(id: number): boolean;
	snapshot(id: number, after: string | undefined, limit: number): RowPage | undefined;
	patch(from: number, to: number): TrieRow[] | undefined;
}

export function createIndexerTrie(kind: CommitKind, layout: RegistrarLayout): IndexerTrie {
	return kind === "linea" ? new LineaIndexerTrie(layout) : new MPTIndexerTrie(layout);
}

function page(rows: Iterable<TrieRow>, limit: number): RowPage {
	const out: TrieRow[] = [];
	for (const row of rows) {
		out.push(row);
		if (out.length === limit) break;
	}
	return { rows: out, next: out.length === limit ? out[out.length - 1].path : null };
}

// Merkle-Patricia (OP): merkle-builder tries are copy-on-write, so a commit is just its root node.
export class MPTIndexerTrie implements IndexerTrie {
	private storage = new EthStorage();
	private readonly roots = new Map<number, MaybeNode>();
	private readonly patches = new Map<string, TrieRow[]>(); // small LRU: gateways ask for the same patch

	constructor(readonly layout: RegistrarLayout) {}

	apply(change: Change) {
		applyChange(this.storage, this.layout, change);
	}
	storageHash(): Hex {
		return this.storage.storageHash;
	}
	capture(id: number) {
		this.roots.set(id, this.storage.node);
	}
	captureFrom(id: number, _l2Block: number, changes: Iterable<Change>): Hex {
		const storage = new EthStorage();
		for (const c of changes) applyChange(storage, this.layout, c);
		this.roots.set(id, storage.node);
		return storage.storageHash;
	}
	retain(ids: Set<number>) {
		for (const id of this.roots.keys()) if (!ids.has(id)) this.roots.delete(id);
	}
	has(id: number) {
		return this.roots.has(id);
	}
	snapshot(id: number, after: string | undefined, limit: number): RowPage | undefined {
		if (!this.roots.has(id)) return;
		return page(trieRows(this.roots.get(id), after), limit);
	}
	patch(from: number, to: number): TrieRow[] | undefined {
		const key = `${from}:${to}`;
		let rows = this.patches.get(key);
		if (!rows) {
			if (!this.roots.has(from) || !this.roots.has(to)) return;
			rows = diffRows(this.roots.get(from), this.roots.get(to));
			this.patches.set(key, rows);
			if (this.patches.size > 16) this.patches.delete(this.patches.keys().next().value!);
		}
		return rows;
	}
}

// Linea: the trie is mutable, so its rows are logged per L2 block and a commit is a version.
// Changes within one block are buffered and applied together (Shomei's per-block semantics).
export class LineaIndexerTrie implements IndexerTrie {
	private readonly storage = new LineaStorageTrie();
	private readonly log = new RowLog();
	private readonly versions = new Map<number, number>(); // commit id => L2 block
	private block = -1; // block of the buffered changes

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
	}
	storageHash(): Hex {
		this.endBlock();
		return this.storage.storageRoot;
	}
	capture(id: number, l2Block: number) {
		this.endBlock();
		if (l2Block < this.block) throw new Error(`commit ${id}: block ${l2Block} is before applied changes`);
		this.versions.set(id, l2Block);
		this.log.keep(this.versions.values());
	}
	captureFrom(id: number): Hex {
		throw new Error(`commit ${id}: out of order (Linea commits are processed in block order)`);
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
	private kept: number[] = []; // ascending
	private sorted: string[] | undefined; // path order cache

	keep(versions: Iterable<number>) {
		this.kept = [...new Set(versions)].sort((a, b) => a - b);
		this.prune();
	}

	// an entry at version u is still read if some kept version k has u <= k < v (the next entry's version)
	private needed(u: number, v: number): boolean {
		let lo = 0;
		let hi = this.kept.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.kept[mid] < u) lo = mid + 1;
			else hi = mid;
		}
		return lo < this.kept.length && this.kept[lo] < v;
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
			if (last.v !== v && this.needed(last.v, v)) {
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
			const kept = entries.filter((e, i) => i === entries.length - 1 || this.needed(e.v, entries[i + 1].v));
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
