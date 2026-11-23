// RPCChangeReader's getLogs range handling against fake providers.

import { expect, test } from "bun:test";
import { RPCChangeReader } from "@primary-name-gateway/registrar-indexer";
import { OP_MAINNET } from "@primary-name-gateway/shared";
import type { PublicClient } from "viem";

// a provider that rejects ranges above `maxRange`, or results above `maxResults` (`density` logs per block,
// returned when `withLogs`)
function fakeClient({
	maxRange = Infinity,
	maxResults = Infinity,
	density = 0 as number | ((block: number) => number),
	withLogs = false,
}) {
	const ranges: number[] = []; // every request
	const ok: number[] = []; // successful requests
	const client = {
		async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
			const n = Number(toBlock - fromBlock) + 1;
			ranges.push(n);
			if (n > maxRange) throw new Error(`query returned more than: range ${n} exceeds limit of ${maxRange}`);
			const blocks = Array.from({ length: withLogs ? n : 0 }, (_, i) => Number(fromBlock) + i);
			const perBlock = typeof density === "number" ? () => density : density;
			const count = withLogs ? blocks.reduce((s, b) => s + perBlock(b), 0) : n * (density as number);
			if (count > maxResults) throw new Error(`query exceeds max results ${maxResults}`);
			ok.push(n);
			return blocks.flatMap((b) =>
				Array.from({ length: perBlock(b) }, (_, logIndex) => ({
					eventName: "OwnershipTransferred",
					args: { newOwner: "0x0000000000000000000000000000000000000001" },
					blockNumber: BigInt(b),
					logIndex,
				})),
			);
		},
	};
	return { client: client as unknown as PublicClient, ranges, ok };
}

async function syncAll(reader: RPCChangeReader, from: number, to: number) {
	while (from <= to) from = (await reader.getChanges(from, to)).toBlock + 1;
}

test("a stated range limit caps the range for good", async () => {
	const { client, ranges } = fakeClient({ maxRange: 10000 });
	const reader = new RPCChangeReader(OP_MAINNET, client); // up to 500000
	await syncAll(reader, 0, 1_000_000);
	const after = ranges.slice(ranges.findIndex((n) => n > 10000) + 1); // after the first refusal
	expect(after.every((n) => n <= 10000)).toBeTrue(); // never grows back into the limit
	expect(Math.max(...after)).toBe(10000);
});

test("a result cap shrinks the range, which grows back once results are sparse", async () => {
	const dense = fakeClient({ maxResults: 20000, density: 25 });
	const reader = new RPCChangeReader(OP_MAINNET, dense.client);
	await syncAll(reader, 0, 10_000);
	expect(Math.max(...dense.ok)).toBeLessThanOrEqual(20000 / 25);
	// same reader, sparse blocks: back to the full step (a result cap isn't a range limit)
	const sparse = fakeClient({});
	Object.assign(reader, { logsClient: sparse.client });
	await syncAll(reader, 10_001, 3_000_000);
	expect(Math.max(...sparse.ranges)).toBe(500000);
});

test("ranges are sized from the last one's density, so a dense stretch rarely fails", async () => {
	// sparse, then 3 logs per block (Base's densest), then sparse again
	const density = (b: number) => (b >= 100_000 && b < 300_000 ? 3 : b % 1000 === 0 ? 1 : 0);
	const { client, ranges, ok } = fakeClient({ maxResults: 15_000, density, withLogs: true });
	const reader = new RPCChangeReader(OP_MAINNET, client);
	await syncAll(reader, 0, 2_000_000);
	expect(ranges.length - ok.length).toBeLessThanOrEqual(5); // only where it turns dense (1000x)
	// 600,000 dense logs at about 5,000 per range, not tiny ranges
	expect(ok.filter((n) => n < 5000).length).toBeWithin(110, 200);
	expect(Math.max(...ok)).toBe(500000); // back to the widest range once sparse
});
