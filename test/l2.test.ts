// RPCChangeReader's getLogs range handling against fake providers.

import { expect, test } from "bun:test";
import { RPCChangeReader } from "@primary-name-gateway/registrar-indexer";
import { OP_MAINNET } from "@primary-name-gateway/shared";
import type { PublicClient } from "viem";

// a provider that rejects ranges above `maxRange`, or results above `maxResults` (`density` logs per block)
function fakeClient({ maxRange = Infinity, maxResults = Infinity, density = 0 }) {
	const ranges: number[] = []; // every request
	const ok: number[] = []; // successful requests
	const client = {
		async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
			const n = Number(toBlock - fromBlock) + 1;
			ranges.push(n);
			if (n > maxRange) throw new Error(`query returned more than: range ${n} exceeds limit of ${maxRange}`);
			if (n * density > maxResults) throw new Error(`query exceeds max results ${maxResults}`);
			ok.push(n);
			return [];
		},
	};
	return { client: client as unknown as PublicClient, ranges, ok };
}

async function syncAll(reader: RPCChangeReader, from: number, to: number) {
	while (from <= to) from = (await reader.getChanges(from, to)).toBlock + 1;
}

test("a stated range limit caps the range for good", async () => {
	const { client, ranges } = fakeClient({ maxRange: 10000 });
	const reader = new RPCChangeReader(OP_MAINNET, client); // logStep 500000
	await syncAll(reader, 0, 1_000_000);
	const after = ranges.slice(ranges.findIndex((n) => n <= 10000));
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
