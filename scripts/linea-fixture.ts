// Capture a Linea mainnet fixture for packages/contracts/test/LineaVerifier.t.sol:
// the latest finalized state root, the registrar's account proof, and storage proofs for
// a short name, a long name and an unset address.
//   bun scripts/linea-fixture.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dataSlots, LINEA_MAINNET, primarySlot, REGISTRAR_ABI, rpcURL } from "@primary-name-gateway/shared";
import {
	createPublicClient,
	decodeAbiParameters,
	getAbiItem,
	type Hex,
	http,
	numberToHex,
	parseAbi,
	toHex,
} from "viem";

const d = LINEA_MAINNET;
const l1 = createPublicClient({ transport: http(rpcURL(d.l1)) });
const l2 = createPublicClient({ transport: http(rpcURL(d.l2)) });
const ROLLUP_ABI = parseAbi([
	"function currentL2BlockNumber() view returns (uint256)",
	"function stateRootHashes(uint256) view returns (bytes32)",
]);
const l2Block = await l1.readContract({
	address: d.LineaRollup,
	abi: ROLLUP_ABI,
	functionName: "currentL2BlockNumber",
});
const stateRoot = await l1.readContract({
	address: d.LineaRollup,
	abi: ROLLUP_ABI,
	functionName: "stateRootHashes",
	args: [l2Block],
});

// latest name per address
const names = new Map<Hex, Hex>();
const logs = await l2.getLogs({
	address: d.L2ReverseRegistrar,
	event: getAbiItem({ abi: REGISTRAR_ABI, name: "NameForAddrChanged" }),
	fromBlock: BigInt(d.registrarCreatedAtBlock),
	toBlock: l2Block,
	strict: true,
});
for (const log of logs) names.set(log.args.addr, decodeAbiParameters([{ type: "bytes" }], log.data)[0]);
const pick = (pred: (n: number) => boolean) => [...names].find(([, n]) => pred((n.length - 2) / 2))!;
const [shortAddr, shortName] = pick((n) => n > 0 && n < 32);
const [longAddr, longName] = pick((n) => n >= 32);
const unsetAddr: Hex = "0x000000000000000000000000000000000000dEaD";

const shortSlot = primarySlot(shortAddr);
const longSlot = primarySlot(longAddr);
const slots = [shortSlot, longSlot, primarySlot(unsetAddr)];
const first: any = await l2.request({
	method: "linea_getProof" as any,
	params: [d.L2ReverseRegistrar, slots.map((s) => toHex(s)), numberToHex(l2Block)] as any,
});
const longHeader = first.storageProofs[1].proof.value as Hex;
const extra = dataSlots(longSlot, Buffer.from(longHeader.slice(2), "hex"));
const second: any = await l2.request({
	method: "linea_getProof" as any,
	params: [d.L2ReverseRegistrar, extra.map((s) => toHex(s)), numberToHex(l2Block)] as any,
});

const fixture = {
	l2Block: Number(l2Block),
	stateRoot,
	registrar: d.L2ReverseRegistrar,
	accountProof: first.accountProof,
	short: { addr: shortAddr, name: shortName, slot: toHex(shortSlot), proof: first.storageProofs[0] },
	long: {
		addr: longAddr,
		name: longName,
		slot: toHex(longSlot),
		proof: first.storageProofs[1],
		data: second.storageProofs,
	},
	unset: { addr: unsetAddr, slot: toHex(slots[2]), proof: first.storageProofs[2] },
};
const dir = `${import.meta.dir}/../packages/contracts/test/fixtures`;
mkdirSync(dir, { recursive: true });
const path = `${dir}/linea.json`;
writeFileSync(path, `${JSON.stringify(fixture, null, "\t")}\n`);
console.log(`wrote ${path}: L2 block ${l2Block}, ${names.size} names, long name ${(longName.length - 2) / 2} bytes`);
