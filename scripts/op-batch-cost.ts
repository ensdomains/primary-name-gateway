// What reading an OP Stack batch prefix out of a brotli channel takes: the numbers that size a
// Solidity port of brotliDecodePrefix. Reads frame-0 files (channel version byte + brotli stream).
//
//   bun scripts/op-batch-cost.ts [files...]   (default: packages/contracts/test/fixtures/op-batch/*.bin)

import { readdirSync } from "node:fs";
import { brotliDecodePrefix, decodeBatchPrefix } from "@primary-name-gateway/shared";

const dir = `${import.meta.dir}/../packages/contracts/test/fixtures/op-batch`;
const files = process.argv.slice(2);
if (!files.length) for (const f of readdirSync(dir).filter((x) => x.endsWith(".bin"))) files.push(`${dir}/${f}`);

for (const file of files) {
	const frame = new Uint8Array(await Bun.file(file).arrayBuffer());
	if (frame[0] !== 1) throw new Error(`${file}: channel version ${frame[0]}, expected 1 (brotli)`);
	// enough for either batch type's prefix: singular ~110 bytes, span ~50
	const { output, stats } = brotliDecodePrefix(frame.subarray(1), 112);
	const batch = decodeBatchPrefix(output);
	const fieldElements = Math.ceil(Math.ceil(stats.bits / 8) / 127) * 4; // 4 field elements carry 127 bytes
	console.log(file.split("/").pop(), {
		batch: batch.type,
		compressedBytes: Math.ceil(stats.bits / 8),
		headerBytes: Math.ceil(stats.headerBits / 8),
		blobFieldElements: fieldElements,
		...stats,
	});
}
