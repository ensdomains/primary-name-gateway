// rawTransaction (shared/op-batch.ts): the inbox indexer re-encodes a block's transactions from
// eth_getBlockByNumber(n, true) to prove one of them, instead of eth_getRawTransactionByHash per
// transaction. Real mainnet transactions of every type, against their signed bytes.

import { expect, test } from "bun:test";
import { rawTransaction } from "@primary-name-gateway/shared";
import type { Hex, RpcTransaction } from "viem";

const { txs } = (await Bun.file(
	`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/raw-txs.json`,
).json()) as { txs: { rpc: RpcTransaction; raw: Hex }[] };

test("every transaction type re-encodes to its signed bytes", () => {
	expect([...new Set(txs.map((t) => t.rpc.type))].sort()).toEqual(["0x0", "0x1", "0x2", "0x3", "0x4"]);
	for (const { rpc, raw } of txs) expect(rawTransaction(rpc)).toBe(raw);
});

test("the calldata is part of it", () => {
	const { rpc, raw } = txs.find((t) => t.rpc.input.length > 10)!;
	expect(rawTransaction({ ...rpc, input: "0x" })).not.toBe(raw);
});
