import {
	type Commit,
	chunkReader,
	dataSlots,
	encodeLineaMultiProof,
	encodeMPTStorageProofs,
	LINEA_ROOT_PATH,
	lineaRootHash,
	PLAIN_LAYOUT,
	primarySlot,
	proveLineaSlots,
	proveSlot,
	type RegistrarLayout,
	ROW_FORMAT_LINEA,
	ROW_FORMAT_MPT,
	rootHash,
	type SnapshotPage,
	type TrieRow,
} from "@primary-name-gateway/shared";
import { encodeAbiParameters, type Hex } from "viem";
import type { NodeStore } from "./store.js";

export type GatewayConfig = {
	indexerURL: string;
	layout?: RegistrarLayout; // registrar storage layout (default: names at slot 0), see docs/registrar.md
	keepCommits: number; // valid commits to hold (the newest, and fallbacks while serveDelaySec runs)
	// Serve a commit only once it has been valid this long (default 0). The indexer judges validity on
	// finalized L1, and validity only grows with L1, so a client reading at latest is already past it; a
	// delay only helps clients that read at finalized on a node that saw finality a little later.
	serveDelaySec?: number;
	log?: (...args: unknown[]) => void;
	fetch?: typeof fetch;
};

export type GatewayStats = { snapshots: number; patches: number; rows: number };

// the last sync: when it ended (unix seconds), how long it took, and its error if it failed
export type SyncResult = { at: number; ms: number; error?: string };

type Bootstrap = { commit: Commit; after: string | null };

const META_HELD = "held"; // commits we serve
const META_HEAD = "head"; // newest commit whose rows are in the store (patches start here)
const META_BOOTSTRAP = "bootstrap";
const META_FORMAT = "format"; // how the store's rows are laid out
// OP Stack rows are chunks (shared/trie.ts); a store from before that starts over with a snapshot
const STORE_FORMAT = "chunks-4";

// Mirrors the latest valid commits of a registrar-indexer as versioned trie rows in a NodeStore
// and proves names[addr] by walking rows. It never builds a trie and never hashes nodes: only
// slot keys (keccak for OP, Poseidon2 for Linea) and the root row of each commit it loads.
// The rows' shape depends on the commit kind (see shared/trie.ts and shared/linea.ts).
//
// - first start: page through /snapshot of a valid commit (resumable)
// - afterwards: /patch?from=<newest held>&to=<new commit>
// - restart: state lives in the store, so it resumes with patches
export class RegistrarGateway {
	readonly stats: GatewayStats = { snapshots: 0, patches: 0, rows: 0 };
	lastSync: SyncResult | undefined;
	private waiting = false; // the indexer had no valid commit at the last sync

	constructor(
		readonly store: NodeStore,
		readonly config: GatewayConfig,
	) {}

	private log(...args: unknown[]) {
		this.config.log?.(...args);
	}

	// held commits, ascending by L2 block
	get commits(): Commit[] {
		const json = this.store.getMeta(META_HELD);
		return json ? JSON.parse(json) : [];
	}
	private setHeld(held: Commit[]) {
		this.store.setMeta(META_HELD, JSON.stringify(held));
	}
	// may differ from commits.at(-1) if that commit stopped being valid: its rows are still there
	private get head(): Commit | undefined {
		const json = this.store.getMeta(META_HEAD);
		return json ? JSON.parse(json) : undefined;
	}
	private setHead(commit: Commit | undefined) {
		this.store.setMeta(META_HEAD, commit && JSON.stringify(commit));
	}

	async sync() {
		const t0 = Date.now();
		try {
			await this.syncOnce();
			this.lastSync = { at: Math.floor(Date.now() / 1000), ms: Date.now() - t0 };
		} catch (err) {
			const error = err instanceof Error ? err.message.split("\n")[0] : String(err);
			this.lastSync = { at: Math.floor(Date.now() / 1000), ms: Date.now() - t0, error };
			throw err;
		}
	}

	private async syncOnce() {
		const { keepCommits: keep } = this.config;
		if (this.store.getMeta(META_FORMAT) !== STORE_FORMAT) {
			if (this.store.getMeta(META_HEAD)) this.log("the store's rows are in an older layout: starting over");
			this.store.clear();
			this.setHeld([]);
			this.setHead(undefined);
			this.store.setMeta(META_BOOTSTRAP, undefined);
			this.store.setMeta(META_FORMAT, STORE_FORMAT);
		}
		const resume = this.store.getMeta(META_BOOTSTRAP);
		if (resume) await this.bootstrap(JSON.parse(resume));

		const targets: Commit[] = await this.fetchJSON(`/commits?status=valid&limit=${keep}`);
		targets.sort((a, b) => a.l2Block - b.l2Block || a.id - b.id);
		// said once, not on every poll
		if (!targets.length && !this.waiting) this.log("the indexer has no valid commit yet: waiting");
		this.waiting = !targets.length;
		const valid = new Set(targets.map((c) => c.id));
		// drop held commits that are no longer valid (blacklisted/retired); their rows get pruned
		let held = this.commits.filter((c) => valid.has(c.id));
		for (const target of targets) {
			if (held.some((c) => c.id === target.id)) continue;
			let head = this.head;
			if (head && !valid.has(head.id) && (await this.isInvalid(head))) {
				// the store's newest commit stopped being valid: rewind to the newest held commit
				head = held.at(-1);
				if (head) {
					this.store.truncate(head.l2Block);
					this.setHead(head);
					this.log(`rewound to commit ${head.id}`);
				}
			}
			if (head && target.l2Block < head.l2Block) continue; // older than what we have
			if (head && target.l2Block === head.l2Block && target.storageHash === head.storageHash) {
				held.push(target); // same L2 block, different game: same rows
			} else if (head && (await this.applyPatch(head, target))) {
				held.push(target);
			} else {
				await this.bootstrap({ commit: target, after: null });
				held = [target];
			}
			this.setHeld(held);
		}
		held = held.slice(-keep);
		this.setHeld(held);
		if (held.length) this.store.prune(held[0].l2Block);
	}

	private async applyPatch(from: Commit, to: Commit): Promise<boolean> {
		const res = await this.fetchRaw(`/patch?from=${from.id}&to=${to.id}`);
		if (res.status === 404) return false; // indexer no longer has `from`: start over
		if (!res.ok) throw new Error(`patch ${from.id} => ${to.id}: ${res.status}`);
		this.checkFormat(res, to);
		const rows = (await res.json()) as TrieRow[];
		this.store.put(to.l2Block, rows);
		this.setHead(to);
		this.stats.patches++;
		this.stats.rows += rows.length;
		if (!this.checkRoot(to)) {
			this.log(`patch ${from.id} => ${to.id} gave the wrong root: starting over`);
			return false;
		}
		this.log(`holding commit ${to.id}: L2 block ${to.l2Block} (+${rows.length} rows)`);
		return true;
	}

	// load a full snapshot (resumable: the cursor is saved after each page)
	private async bootstrap({ commit, after }: Bootstrap) {
		if (after === null) {
			this.store.clear();
			this.setHeld([]);
			this.setHead(undefined);
		}
		this.store.setMeta(META_BOOTSTRAP, JSON.stringify({ commit, after }));
		this.log(
			`${after === null ? "loading" : "resuming"} the snapshot of commit ${commit.id} (L2 block ${commit.l2Block})`,
		);
		const t0 = Date.now();
		let rows = 0;
		let pages = 0;
		let shown = t0;
		for (;;) {
			const query = after === null ? "" : `&after=${after}`;
			const res = await this.fetchRaw(`/snapshot?commit=${commit.id}${query}`);
			if (!res.ok) throw new Error(`snapshot ${commit.id}: ${res.status} ${await res.text()}`);
			this.checkFormat(res, commit);
			const page = (await res.json()) as SnapshotPage;
			this.store.put(commit.l2Block, page.rows);
			rows += page.rows.length;
			pages++;
			if (Date.now() - shown >= 10_000) {
				shown = Date.now();
				this.log(
					`snapshot of commit ${commit.id}: ${rows.toLocaleString("en-US")} rows in ${pages} pages so far (${Math.round((shown - t0) / 1000)}s)`,
				);
			}
			if (page.next === null) break;
			after = page.next;
			this.store.setMeta(META_BOOTSTRAP, JSON.stringify({ commit, after }));
		}
		this.store.setMeta(META_BOOTSTRAP, undefined);
		if (!this.checkRoot(commit)) throw new Error(`snapshot of commit ${commit.id} has the wrong root`);
		this.setHeld([commit]);
		this.setHead(commit);
		this.stats.snapshots++;
		this.stats.rows += rows;
		const sec = Math.round((Date.now() - t0) / 1000);
		this.log(
			`holding commit ${commit.id}: L2 block ${commit.l2Block} (snapshot, ${rows.toLocaleString("en-US")} rows, ${sec}s)`,
		);
	}

	private async isInvalid(commit: Commit): Promise<boolean> {
		const res = await this.fetchRaw(`/commits/${commit.id}`);
		if (res.status === 404) return true;
		if (!res.ok) throw new Error(`commit ${commit.id}: ${res.status}`);
		return ((await res.json()) as Commit).status === "invalid";
	}

	// rows in another layout would load fine and then fail every proof
	private checkFormat(res: Response, commit: Commit) {
		const want = commit.kind === "linea" ? ROW_FORMAT_LINEA : ROW_FORMAT_MPT;
		const got = res.headers.get("x-row-format");
		if (got !== want) throw new Error(`the indexer serves ${got ?? "unlabelled"} rows, expected ${want}`);
	}

	private checkRoot(commit: Commit): boolean {
		const root =
			commit.kind === "linea"
				? lineaRootHash(this.store.get(LINEA_ROOT_PATH, commit.l2Block))
				: rootHash(this.store.get("", commit.l2Block));
		return root === commit.storageHash;
	}

	// newest commit that has been valid for at least serveDelaySec, else the oldest held
	pick(now = Math.floor(Date.now() / 1000)): Commit {
		const held = this.commits;
		if (!held.length) throw new Error("no valid commits yet");
		for (let i = held.length - 1; i >= 0; i--) {
			if ((held[i].validAt ?? 0) + (this.config.serveDelaySec ?? 0) <= now) return held[i];
		}
		return held[0];
	}

	// ABI-encoded NameProof (see L2ReverseResolver.sol)
	// id: prove against a specific held commit (default: pick())
	proveName(addr: Hex, id?: number): { proof: Hex; commit: Commit } {
		const commit = id === undefined ? this.pick() : this.commits.find((c) => c.id === id);
		if (!commit) throw new Error(`not holding commit ${id}`);
		const version = commit.l2Block;
		const get = (path: string) => this.store.get(path, version);
		const slot = primarySlot(addr, (this.config.layout ?? PLAIN_LAYOUT).namesSlot);
		let storageProof: Hex;
		let count: number;
		if (commit.kind === "linea") {
			const floor = (prefix: string, before: string) => this.store.floor(prefix, before, version);
			const [header] = proveLineaSlots(get, floor, [slot]).values;
			const slots = [slot, ...dataSlots(slot, header)];
			storageProof = encodeLineaMultiProof(proveLineaSlots(get, floor, slots).proof); // one multiproof
			count = slots.length - 1;
		} else {
			const read = chunkReader(get); // reads each chunk once for all the slots
			const header = proveSlot(read, slot);
			const data = dataSlots(slot, header.value).map((s) => proveSlot(read, s).proof);
			storageProof = encodeMPTStorageProofs([header.proof, ...data]);
			count = data.length;
		}
		const proof = encodeAbiParameters(
			[
				{
					type: "tuple",
					components: [
						{ name: "commitProof", type: "bytes" },
						{ name: "accountProof", type: "bytes" },
						{ name: "dataSlots", type: "uint256" },
						{ name: "storageProof", type: "bytes" },
					],
				},
			],
			[
				{
					commitProof: commit.commitProof,
					accountProof: commit.accountProof,
					dataSlots: BigInt(count),
					storageProof,
				},
			],
		);
		return { proof, commit };
	}

	private fetchRaw(path: string): Promise<Response> {
		return (this.config.fetch ?? fetch)(`${this.config.indexerURL}${path}`);
	}

	private async fetchJSON<T>(path: string): Promise<T> {
		const res = await this.fetchRaw(path);
		if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
		return res.json() as Promise<T>;
	}
}
