// Chunk rows (see shared/trie.ts) from a version's node rows: snapshot pages and patches.
import { CHUNK_DEPTH, chunkId, encodeLimb, nextPrefix, type TrieRow } from "@primary-name-gateway/shared";
import { bytesToHex, hexToBytes } from "viem";

// the live nodes of one version
export type NodeSource = {
	// nodes with from <= path < to (to undefined: no bound), in path order
	range(from: string, to: string | undefined, limit: number): TrieRow[];
	get(path: string): Uint8Array | undefined;
};

const BATCH = 10_000;

// Whole chunks after chunk `after`, in id order, until at least `budget` nodes; `next` resumes.
export function chunkPage(
	src: NodeSource,
	after: string | undefined,
	budget: number,
): { rows: TrieRow[]; next: string | null } {
	// every path after `after`'s chunk: past a trunk node is its first child; past a limb, the next prefix
	let from: string | undefined =
		after === undefined ? "" : after.length < CHUNK_DEPTH ? `${after}0` : nextPrefix(after);
	const rows: TrieRow[] = [];
	let nodes = 0;
	let limbId: string | undefined;
	let limb: { suffix: string; node: Uint8Array }[] = [];
	const endLimb = () => {
		if (limbId === undefined) return;
		rows.push({ path: limbId, node: bytesToHex(encodeLimb(limb)) });
		limbId = undefined;
		limb = [];
	};
	while (from !== undefined) {
		const batch = src.range(from, undefined, BATCH);
		for (const { path, node } of batch) {
			const id = chunkId(path);
			if (id !== limbId) {
				endLimb();
				if (nodes >= budget) return { rows, next: rows[rows.length - 1].path };
				if (path.length < CHUNK_DEPTH) {
					rows.push({ path, node }); // a trunk node
					nodes++;
					continue;
				}
				limbId = id;
			}
			limb.push({ suffix: path.slice(CHUNK_DEPTH), node: hexToBytes(node!) });
			nodes++;
		}
		if (batch.length < BATCH) break;
		from = `${batch[batch.length - 1].path}0`; // the next path after it
	}
	endLimb();
	return { rows, next: null };
}

// The chunk rows that turn one version into another, given the paths of the nodes that changed:
// every chunk holding one of them, as it is now (null: removed).
export function chunkPatch(changed: Iterable<string>, src: NodeSource): TrieRow[] {
	const ids = [...new Set([...changed].map(chunkId))].sort();
	return ids.map((id) => {
		if (id.length < CHUNK_DEPTH) {
			const node = src.get(id);
			return { path: id, node: node ? bytesToHex(node) : null };
		}
		const nodes = src.range(id, nextPrefix(id), Number.MAX_SAFE_INTEGER);
		const limb = nodes.map(({ path, node }) => ({ suffix: path.slice(CHUNK_DEPTH), node: hexToBytes(node!) }));
		return { path: id, node: limb.length ? bytesToHex(encodeLimb(limb)) : null };
	});
}
