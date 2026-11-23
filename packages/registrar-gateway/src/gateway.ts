import {
	type Commit,
	dataSlots,
	primarySlot,
	proveSlot,
	rootHash,
	type SnapshotPage,
	type TrieRow,
} from "@primary-name-gateway/shared";
import { encodeAbiParameters, type Hex } from "viem";
import type { NodeStore } from "./store.js";

export type GatewayConfig = {
	indexerURL: string;
	keep: number; // number of valid commits to hold (latest + fallbacks)
	marginSec: number; // only serve a commit once it has been valid this long (L1 nodes lag)
	log?: (...args: unknown[]) => void;
	fetch?: typeof fetch;
};

export type GatewayStats = { snapshots: number; patches: number; rows: number };

type Bootstrap = { commit: Commit; after: string | null };

const META_HELD = "held"; // commits we serve
const META_HEAD = "head"; // newest commit whose rows are in the store (patches start here)
const META_BOOTSTRAP = "bootstrap";

// Mirrors the latest valid commits of a registrar-indexer as versioned trie rows in a NodeStore
// and proves names[addr] by walking rows. It never builds a trie and never hashes (except one
// keccak per commit to check the root row).
//
// - first start: page through /snapshot of a valid commit (resumable)
// - afterwards: /patch?from=<newest held>&to=<new commit>
// - restart: state lives in the store, so it resumes with patches
export class RegistrarGateway {
	readonly stats: GatewayStats = { snapshots: 0, patches: 0, rows: 0 };

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
		const { keep } = this.config;
		const resume = this.store.getMeta(META_BOOTSTRAP);
		if (resume) await this.bootstrap(JSON.parse(resume));

		const targets: Commit[] = await this.fetchJSON(`/commits?status=valid&limit=${keep}`);
		targets.sort((a, b) => a.l2Block - b.l2Block || a.gameIndex - b.gameIndex);
		const valid = new Set(targets.map((c) => c.gameIndex));
		// drop held commits that are no longer valid (blacklisted/retired); their rows get pruned
		let held = this.commits.filter((c) => valid.has(c.gameIndex));
		for (const target of targets) {
			if (held.some((c) => c.gameIndex === target.gameIndex)) continue;
			let head = this.head;
			if (head && !valid.has(head.gameIndex) && (await this.isInvalid(head))) {
				// the store's newest commit stopped being valid: rewind to the newest held commit
				head = held.at(-1);
				if (head) {
					this.store.truncate(head.l2Block);
					this.setHead(head);
					this.log(`rewound to game ${head.gameIndex}`);
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
		const res = await this.fetchRaw(`/patch?from=${from.gameIndex}&to=${to.gameIndex}`);
		if (res.status === 404) return false; // indexer no longer has `from`: start over
		if (!res.ok) throw new Error(`patch ${from.gameIndex} => ${to.gameIndex}: ${res.status}`);
		const rows = (await res.json()) as TrieRow[];
		this.store.put(to.l2Block, rows);
		this.setHead(to);
		this.stats.patches++;
		this.stats.rows += rows.length;
		if (!this.checkRoot(to)) {
			this.log(`patch ${from.gameIndex} => ${to.gameIndex} gave the wrong root: starting over`);
			return false;
		}
		this.log(`holding game ${to.gameIndex}: L2 block ${to.l2Block} (+${rows.length} rows)`);
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
		let rows = 0;
		for (;;) {
			const query = after === null ? "" : `&after=${after}`;
			const page: SnapshotPage = await this.fetchJSON(`/snapshot?game=${commit.gameIndex}${query}`);
			this.store.put(commit.l2Block, page.rows);
			rows += page.rows.length;
			if (page.next === null) break;
			after = page.next;
			this.store.setMeta(META_BOOTSTRAP, JSON.stringify({ commit, after }));
		}
		this.store.setMeta(META_BOOTSTRAP, undefined);
		if (!this.checkRoot(commit)) throw new Error(`snapshot of game ${commit.gameIndex} has the wrong root`);
		this.setHeld([commit]);
		this.setHead(commit);
		this.stats.snapshots++;
		this.stats.rows += rows;
		this.log(`holding game ${commit.gameIndex}: L2 block ${commit.l2Block} (snapshot, ${rows} rows)`);
	}

	private async isInvalid(commit: Commit): Promise<boolean> {
		const res = await this.fetchRaw(`/commits/${commit.gameIndex}`);
		if (res.status === 404) return true;
		if (!res.ok) throw new Error(`commit ${commit.gameIndex}: ${res.status}`);
		return ((await res.json()) as Commit).status === "invalid";
	}

	private checkRoot(commit: Commit): boolean {
		return rootHash(this.store.get("", commit.l2Block)) === commit.storageHash;
	}

	// newest commit that has been valid for at least marginSec, else the oldest held
	pick(now = Math.floor(Date.now() / 1000)): Commit {
		const held = this.commits;
		if (!held.length) throw new Error("no valid commits yet");
		for (let i = held.length - 1; i >= 0; i--) {
			if ((held[i].validAt ?? 0) + this.config.marginSec <= now) return held[i];
		}
		return held[0];
	}

	// ABI-encoded NameProof (see L2ReverseResolver.sol)
	// gameIndex: prove against a specific held commit (default: pick())
	proveName(addr: Hex, gameIndex?: number): { proof: Hex; commit: Commit } {
		const commit = gameIndex === undefined ? this.pick() : this.commits.find((c) => c.gameIndex === gameIndex);
		if (!commit) throw new Error(`not holding game ${gameIndex}`);
		const get = (path: string) => this.store.get(path, commit.l2Block);
		const slot = primarySlot(addr);
		const header = proveSlot(get, slot);
		const storageProofs = [header.proof, ...dataSlots(slot, header.value).map((s) => proveSlot(get, s).proof)];
		const proof = encodeAbiParameters(
			[
				{
					type: "tuple",
					components: [
						{ name: "commitProof", type: "bytes" },
						{ name: "accountProof", type: "bytes[]" },
						{ name: "storageProofs", type: "bytes[][]" },
					],
				},
			],
			[{ commitProof: encodeOPFaultCommitProof(commit), accountProof: commit.accountProof, storageProofs }],
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

// OPFaultCommitProof (see OPFaultVerifier.sol)
export function encodeOPFaultCommitProof(commit: Commit): Hex {
	return encodeAbiParameters(
		[
			{
				type: "tuple",
				components: [
					{ name: "game", type: "address" },
					{ name: "superRoot", type: "bytes" },
					{
						name: "outputRootProof",
						type: "tuple",
						components: [
							{ name: "version", type: "bytes32" },
							{ name: "stateRoot", type: "bytes32" },
							{ name: "messagePasserStorageRoot", type: "bytes32" },
							{ name: "latestBlockhash", type: "bytes32" },
						],
					},
				],
			},
		],
		[{ game: commit.game, superRoot: commit.superRoot, outputRootProof: commit.outputRootProof }],
	);
}
