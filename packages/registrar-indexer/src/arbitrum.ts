import {
	type ArbitrumCommit,
	type ArbitrumDeployment,
	ASSERTION_CONFIRMED,
	ASSERTION_PENDING,
	assertionStateHash,
	BOLD_ROLLUP_ABI,
	decodeArbitrumCommitProof,
	encodeArbitrumCommitProof,
	encodeBlockHeader,
	encodeMPTProof,
	MACHINE_FINISHED,
} from "@primary-name-gateway/shared";
import { getAbiItem, type Hex, type PublicClient } from "viem";
import { type CommitSource, errorMessage, NotFinalizedError, type RegistrarIndexer, SyncError } from "./indexer.js";
import type { InboxL2Reader } from "./l2.js";

export type ArbitrumSourceConfig = {
	deployment: ArbitrumDeployment;
	l1: PublicClient;
	l2: InboxL2Reader; // headers by hash, account proofs, the finalized head
	// L1 blocks back on first start (default: the confirm period and a day, so some are confirmed)
	lookbackBlocks?: number;
	// accept unchallenged pending assertions this many L1 blocks old: must equal the verifier's minAgeBlocks
	// (default 0: confirmed assertions only)
	minAgeBlocks?: number;
	maxAttempts: number;
	logStep?: number; // L1 eth_getLogs range (default 10,000: Infura's limit)
};

const CURSOR = "arbitrumNextL1Block";
const ASSERTION_CREATED = getAbiItem({ abi: BOLD_ROLLUP_ABI, name: "AssertionCreated" });

type Node = { secondChildBlock: bigint; status: number };

// Commits from Arbitrum's BoLD rollup (ArbitrumVerifier, docs/arbitrum.md): every finished assertion
// names an L2 block (its after state's block hash). It is valid once confirmed (about 6.4 days), or
// with minAgeBlocks, once it is that old and nothing on its way from the last confirmed assertion has
// a rival. A confirmed assertion's proof is one link from its parent; an early one's starts at the
// last confirmed ancestor, so its proof is rebuilt when it becomes valid.
//
// Assertions are read from finalized L1 only, and their L2 blocks must be at or below the L2's
// finalized head (addCommit), so nothing stored can reorg.
export class ArbitrumCommitSource implements CommitSource {
	private readonly attempts = new Map<number, number>();
	private confirmPeriod: number | undefined;

	constructor(readonly config: ArbitrumSourceConfig) {}

	status() {
		return { minAgeBlocks: this.config.minAgeBlocks ?? 0 };
	}

	async tick(indexer: RegistrarIndexer) {
		this.applyMinAge(indexer);
		const head = Number((await this.config.l1.getBlock({ blockTag: "finalized" })).number);
		await this.discover(indexer, head);
		await this.refreshStatuses(indexer, head);
	}

	// Which assertions are valid depends on minAgeBlocks. When it changes, valid ones go back to pending
	// and are checked again under the new rule (as OPCommitSource does for minAgeSec).
	private applyMinAge(indexer: RegistrarIndexer) {
		const { db } = indexer;
		const minAge = String(this.config.minAgeBlocks ?? 0);
		const prev = db.getState("minAgeBlocks");
		if (prev === minAge) return;
		if (prev !== undefined) {
			const valid = db.getCommits("valid", Number.MAX_SAFE_INTEGER);
			db.db.transaction(() => {
				for (const c of valid) db.putCommit({ ...c, status: "pending", validAt: undefined });
			})();
			indexer.log(`minAgeBlocks ${prev} → ${minAge}: checking ${valid.length} valid assertions again`);
		}
		db.setState("minAgeBlocks", minAge);
	}

	private async getConfirmPeriod(): Promise<number> {
		this.confirmPeriod ??= Number(
			await retry(() =>
				this.config.l1.readContract({
					address: this.config.deployment.Rollup,
					abi: BOLD_ROLLUP_ABI,
					functionName: "confirmPeriodBlocks",
				}),
			),
		);
		return this.confirmPeriod;
	}

	// new assertions, in order, from the cursor to the finalized L1 head
	private async discover(indexer: RegistrarIndexer, head: number) {
		const { l1, deployment, logStep = 10_000 } = this.config;
		const { db } = indexer;
		const lookback = this.config.lookbackBlocks ?? (await this.getConfirmPeriod()) + 7200;
		let next = Number(db.getState(CURSOR) ?? -1);
		// on first start, and after downtime: older assertions can't be served
		if (next < head - lookback) {
			next = head - lookback;
			db.setState(CURSOR, next);
			indexer.log(`starting at L1 block ${next} (${lookback} blocks of assertions)`);
		}
		while (next <= head) {
			const to = Math.min(head, next + logStep - 1);
			const logs = await retry(() =>
				l1.getLogs({
					address: deployment.Rollup,
					event: ASSERTION_CREATED,
					fromBlock: BigInt(next),
					toBlock: BigInt(to),
				}),
			);
			for (const log of logs) {
				const id = Number(log.blockNumber) * 10000 + log.logIndex;
				if (db.getCommit(id) || db.isSkipped(id)) continue;
				if ((await this.tryAssertion(indexer, id, log)) === "retry") {
					db.setState(CURSOR, Number(log.blockNumber)); // in order: this one first, next tick
					return;
				}
			}
			next = to + 1;
			db.setState(CURSOR, next);
		}
	}

	private async tryAssertion(
		indexer: RegistrarIndexer,
		id: number,
		log: Awaited<ReturnType<PublicClient["getLogs"]>>[number] & {
			args: Partial<{
				assertionHash: Hex;
				parentAssertionHash: Hex;
				assertion: { afterState: Parameters<typeof assertionStateHash>[0] };
				afterInboxBatchAcc: Hex;
			}>;
		},
	): Promise<"done" | "retry"> {
		const { l1, l2, maxAttempts } = this.config;
		const { assertionHash, parentAssertionHash, assertion, afterInboxBatchAcc } = log.args;
		if (!assertionHash || !parentAssertionHash || !assertion || !afterInboxBatchAcc) return "done";
		const afterState = assertion.afterState;
		if (afterState.machineStatus !== MACHINE_FINISHED) {
			indexer.db.putSkipped(id, `${assertionHash}: machine not finished`);
			return "done";
		}
		try {
			const header = await l2.header(afterState.globalState.bytes32Vals[0]);
			const l2Block = Number(BigInt(header.number));
			const [account, block] = await Promise.all([l2.account(l2Block), l1.getBlock({ blockNumber: log.blockNumber! })]);
			const afterStateHash = assertionStateHash(afterState);
			const commit: Omit<ArbitrumCommit, "changeSeq"> = {
				id,
				kind: "arbitrum",
				createdAt: Number(block.timestamp),
				l2Block,
				storageHash: account.storageHash,
				status: "pending",
				assertionHash,
				parentAssertionHash,
				afterStateHash,
				afterInboxBatchAcc,
				l1Block: Number(log.blockNumber),
				// one link from its parent: valid as soon as it's confirmed (the parent is too, by then)
				commitProof: encodeArbitrumCommitProof({
					anchor: parentAssertionHash,
					chain: [afterStateHash, afterInboxBatchAcc],
					afterState,
					l2Header: encodeBlockHeader(header),
				}),
				accountProof: encodeMPTProof(account.accountProof),
			};
			await indexer.addCommit(commit, account.storageHash);
			return "done";
		} catch (err) {
			if (err instanceof NotFinalizedError || err instanceof SyncError) {
				indexer.log(`assertion ${id}: waiting: ${err.message}`);
				return "retry";
			}
			const n = (this.attempts.get(id) ?? 0) + 1;
			this.attempts.set(id, n);
			if (n < maxAttempts) {
				indexer.log(`assertion ${id}: attempt ${n} failed:`, errorMessage(err));
				return "retry";
			}
			indexer.log(`assertion ${id}: skipped after ${n} attempts:`, errorMessage(err));
			indexer.db.putSkipped(id, `${assertionHash}: ${errorMessage(err)}`);
			return "done";
		}
	}

	private async refreshStatuses(indexer: RegistrarIndexer, head: number) {
		const { l1, deployment, minAgeBlocks = 0 } = this.config;
		const { db } = indexer;
		const all = db.getCommits(undefined, 100_000) as ArbitrumCommit[];
		const byHash = new Map(all.map((c) => [c.assertionHash, c]));
		// What might change: confirmed-only, the pending assertions a confirm period old. With
		// minAgeBlocks, the pending ones that old and the valid unconfirmed ones, with every link back.
		const period = await this.getConfirmPeriod();
		const due = all.filter(
			(c) =>
				(c.status === "pending" && c.l1Block + (minAgeBlocks || period) <= head) ||
				(minAgeBlocks > 0 && c.status === "valid"),
		);
		if (!due.length) return;
		// the rollup's view on finalized L1, in batches of 25 (Infura answers part of a large batch with nothing)
		const hashes = minAgeBlocks
			? [...new Set(all.flatMap((c) => [c.assertionHash, c.parentAssertionHash]))]
			: due.map((c) => c.assertionHash);
		const nodes = new Map<Hex, Node>();
		for (let i = 0; i < hashes.length; i += 25) {
			const batch = hashes.slice(i, i + 25);
			const got = await retry(() =>
				Promise.all(
					batch.map((h) =>
						l1.readContract({
							address: deployment.Rollup,
							abi: BOLD_ROLLUP_ABI,
							functionName: "getAssertion",
							args: [h],
							blockTag: "finalized",
						}),
					),
				),
			);
			for (const [j, h] of batch.entries()) nodes.set(h, got[j]);
		}
		// From the last confirmed ancestor to `c`, if every pending link's parent has no rival.
		const chainOf = (c: ArbitrumCommit): { anchor: Hex; chain: Hex[] } | undefined => {
			const chain: Hex[] = [];
			for (let cur: ArbitrumCommit | undefined = c; cur; cur = byHash.get(cur.parentAssertionHash)) {
				chain.unshift(cur.afterStateHash, cur.afterInboxBatchAcc);
				const parent = nodes.get(cur.parentAssertionHash);
				if (!parent) return; // unknown
				if (parent.secondChildBlock !== 0n) return; // challenged
				if (parent.status === ASSERTION_CONFIRMED) return { anchor: cur.parentAssertionHash, chain };
			}
		};
		const now = Math.floor(Date.now() / 1000); // wall-clock: the gateway compares validAt with its own clock
		for (const c of due) {
			const node = nodes.get(c.assertionHash);
			if (!node) continue;
			const confirmed = node.status === ASSERTION_CONFIRMED;
			if (c.status === "pending") {
				if (confirmed) {
					db.putCommit({ ...c, status: "valid", validAt: now });
					indexer.log(`assertion ${c.id}: valid, confirmed (L2 block ${c.l2Block})`);
				} else if (minAgeBlocks && node.status === ASSERTION_PENDING && c.l1Block + minAgeBlocks <= head) {
					const link = chainOf(c);
					if (!link) continue;
					const { afterState, l2Header } = decodeArbitrumCommitProof(c.commitProof);
					const commitProof = encodeArbitrumCommitProof({ ...link, afterState, l2Header });
					db.putCommit({ ...c, status: "valid", validAt: now, commitProof });
					indexer.log(`assertion ${c.id}: valid, unchallenged ${link.chain.length / 2} links from a confirmed one`);
				}
			} else if (c.status === "valid" && !confirmed && !chainOf(c)) {
				// accepted early, then challenged on the way
				db.putCommit({ ...c, status: "invalid" });
				indexer.log(`assertion ${c.id}: invalid (challenged before confirmation)`);
			}
		}
	}
}

// Infura sometimes answers eth_getLogs with nothing: ask again before failing the tick
async function retry<T>(f: () => Promise<T>): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await f();
		} catch (err) {
			if (i === 4) throw err;
			await new Promise((resolve) => setTimeout(resolve, 500 * i));
		}
	}
}
