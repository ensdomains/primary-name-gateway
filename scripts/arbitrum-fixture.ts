// Capture an Arbitrum mainnet fixture for packages/contracts/test/ArbitrumVerifier.t.sol: the latest
// confirmed assertion (with its parent as the anchor) and its pending child, the L2 headers they name,
// the registrar's account proof and storage proofs for a named and an unset address.
//   bun scripts/arbitrum-fixture.ts
import { mkdirSync, writeFileSync } from "node:fs";
import {
	ARBITRUM,
	ARBITRUM_MAINNET,
	assertionStateHash,
	BOLD_ROLLUP_ABI,
	createClient,
	encodeBlockHeader,
	MAINNET,
	primarySlot,
	REGISTRAR_ABI,
	type RpcBlockHeader,
	rpcURL,
} from "@primary-name-gateway/shared";
import { bytesToHex, createPublicClient, getAbiItem, type Hex, http, numberToHex } from "viem";

const ROLLUP = "0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0";
const REGISTRAR = ARBITRUM_MAINNET.L2ReverseRegistrar;
// unbatched: Infura sometimes answers a batched eth_getLogs with nothing
const l1 = createPublicClient({ transport: http(rpcURL(MAINNET), { retryCount: 5 }) });
const l2 = createClient(ARBITRUM);
const l2proof = createClient(ARBITRUM, "proof");
const l2logs = createPublicClient({ transport: http(ARBITRUM.publicRPC) }); // 10M-block getLogs

async function retry<T>(f: () => Promise<T>): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await f();
		} catch (err) {
			if (i === 5) throw err;
			await new Promise((r) => setTimeout(r, 1000 * i));
		}
	}
}

const created = getAbiItem({ abi: BOLD_ROLLUP_ABI, name: "AssertionCreated" });
async function assertion(hash: Hex) {
	const node = await l1.readContract({
		address: ROLLUP,
		abi: BOLD_ROLLUP_ABI,
		functionName: "getAssertion",
		args: [hash],
	});
	const [log] = await retry(() =>
		l1.getLogs({
			address: ROLLUP,
			event: created,
			args: { assertionHash: hash },
			fromBlock: node.createdAtBlock,
			toBlock: node.createdAtBlock,
		}),
	);
	const { parentAssertionHash, assertion, afterInboxBatchAcc } = log.args;
	const afterState = assertion!.afterState;
	const header = (await l2.request({
		method: "eth_getBlockByHash",
		params: [afterState.globalState.bytes32Vals[0], false],
	} as never)) as RpcBlockHeader;
	return {
		hash,
		node: {
			...node,
			firstChildBlock: Number(node.firstChildBlock),
			secondChildBlock: Number(node.secondChildBlock),
			createdAtBlock: Number(node.createdAtBlock),
		},
		parent: parentAssertionHash!,
		afterState: {
			...afterState,
			globalState: { ...afterState.globalState, u64Vals: afterState.globalState.u64Vals.map(String) },
		},
		afterStateHash: assertionStateHash(afterState),
		afterInboxBatchAcc: afterInboxBatchAcc!,
		l2Block: Number(BigInt(header.number)),
		l2Header: encodeBlockHeader(header),
	};
}

const latest = await l1.readContract({ address: ROLLUP, abi: BOLD_ROLLUP_ABI, functionName: "latestConfirmed" });
const confirmed = await assertion(latest);
// its child (pending: confirmation takes ~6.4 days)
const [childLog] = await retry(() =>
	l1.getLogs({
		address: ROLLUP,
		event: created,
		args: { parentAssertionHash: latest },
		fromBlock: BigInt(confirmed.node.firstChildBlock),
		toBlock: BigInt(confirmed.node.firstChildBlock),
	}),
);
const child = await assertion(childLog.args.assertionHash!);

// a short name set before the confirmed block, and an unset address
const nameChanged = getAbiItem({ abi: REGISTRAR_ABI, name: "NameForAddrChanged" });
const logs = await l2logs.getLogs({
	address: REGISTRAR,
	event: nameChanged,
	fromBlock: BigInt(confirmed.l2Block - 9_000_000),
	toBlock: BigInt(confirmed.l2Block),
});
const named = logs.reverse().find((l) => l.args.name && l.args.name.length > 0 && l.args.name.length < 32)!;
const addr = named.args.addr!;
const unset = "0x000000000000000000000000000000000000bEEF";
async function proofs(block: number) {
	const p = (await l2proof.request({
		method: "eth_getProof",
		params: [REGISTRAR, [bytesToHex(primarySlot(addr)), bytesToHex(primarySlot(unset))], numberToHex(block)],
	} as never)) as { accountProof: Hex[]; storageHash: Hex; storageProof: { key: Hex; value: Hex; proof: Hex[] }[] };
	return { accountProof: p.accountProof, storageHash: p.storageHash, storage: p.storageProof };
}
const name = named.args.name!;

const fixture = {
	note: "Arbitrum One mainnet (scripts/arbitrum-fixture.ts)",
	captured: new Date().toISOString().slice(0, 10),
	rollup: ROLLUP,
	registrar: REGISTRAR,
	confirmed,
	child,
	addr,
	name,
	unset,
	atConfirmed: await proofs(confirmed.l2Block),
	atChild: await proofs(child.l2Block),
};
mkdirSync("packages/contracts/test/fixtures", { recursive: true });
writeFileSync("packages/contracts/test/fixtures/arbitrum.json", `${JSON.stringify(fixture, null, "\t")}\n`);
console.log(
	`confirmed ${latest} (L2 block ${confirmed.l2Block}), child ${child.hash} (L2 block ${child.l2Block}, status ${child.node.status}), name ${JSON.stringify(name)} for ${addr}`,
);
