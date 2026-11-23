// OPBatchInboxVerifier as deployed: anvil forks of L1 mainnet shortly after each fixture's batcher
// transaction, so the L1 block hash comes from BLOCKHASH (within 256 blocks) or EIP-2935 history,
// and the batcher from the real SystemConfig. Needs an archive RPC: `bun run test:fork`.

import { afterEach, describe, expect, test } from "bun:test";
import {
	createClient,
	encodeMPTProof,
	encodeOPBatchInboxCommitProof,
	MAINNET,
	rpcURL,
} from "@primary-name-gateway/shared";
import {
	type Abi,
	type Address,
	createPublicClient,
	createWalletClient,
	type Hex,
	http,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// anvil's default account #0 (test key, local fork only)
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

type Fixture = {
	systemConfig: Address;
	inbox: Address;
	l1Block: number;
	l1Header: Hex;
	txIndex: number;
	txProof: Hex[];
	blobIndex: number;
	commitment: Hex;
	fieldElements: Hex;
	proofs: Hex[];
	l2Header: Hex;
	registrar: Address;
	accountProof: Hex[];
	storageHash: Hex;
};

const artifact = (file: string, name: string): { abi: Abi; bytecode: Hex } => {
	const json = require(`../packages/contracts/out/${file}/${name}.json`);
	return { abi: json.abi, bytecode: json.bytecode.object };
};

let anvil: Bun.Subprocess | undefined;
afterEach(() => anvil?.kill());

async function fork(block: number): Promise<PublicClient & { deploy: (args: unknown[]) => Promise<Address> }> {
	const port = 9545 + Math.floor(Math.random() * 1000);
	anvil = Bun.spawn(
		[
			"anvil",
			"--fork-url",
			rpcURL(MAINNET, "proof"),
			"--fork-block-number",
			String(block),
			"--port",
			String(port),
			"--silent",
		],
		{ stdout: "ignore", stderr: "inherit" },
	);
	const transport = http(`http://127.0.0.1:${port}`);
	const client = createPublicClient({ transport });
	for (let i = 0; ; i++) {
		try {
			await client.getBlockNumber();
			break;
		} catch {
			if (anvil.exitCode !== null || i > 100) throw new Error("anvil did not start");
			await Bun.sleep(100);
		}
	}
	const wallet = createWalletClient({ transport, account: DEPLOYER });
	const deploy = async (args: unknown[]) => {
		const hash = await wallet.deployContract({
			...artifact("OPBatchInboxVerifier.sol", "OPBatchInboxVerifier"),
			args,
			account: DEPLOYER,
			chain: null,
		});
		return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
	};
	return Object.assign(client, { deploy });
}

const hasArchive = !!(process.env.ALCHEMY_KEY || process.env.PROOF_RPC_URL_1 || process.env.RPC_URL_1);
const latest = hasArchive ? Number(await createClient(MAINNET).getBlockNumber()) : 0;

describe.skipIf(!hasArchive).each(["op", "base"])("%s", (chain) => {
	for (const [via, after] of [
		["BLOCKHASH", 100],
		["EIP-2935", 2000],
	] as const) {
		test(`L1 block hash from ${via}`, async () => {
			const f: Fixture = await Bun.file(
				`${import.meta.dir}/../packages/contracts/test/fixtures/op-batch/${chain}-blob.json`,
			).json();
			// EIP-2935 serves blocks 257..8191 back: wait until the fixture is that old (or regenerate it)
			const at = Math.min(f.l1Block + after, latest);
			if (at - f.l1Block <= 256 && via === "EIP-2935") {
				console.log(`${chain}: skipped, block ${f.l1Block} is only ${latest - f.l1Block} blocks old`);
				return;
			}
			if (at - f.l1Block > 8191) {
				console.log(`${chain}: skipped, block ${f.l1Block} is past EIP-2935 (regenerate the fixture)`);
				return;
			}
			const l1 = await fork(at);
			const verifier = await l1.deploy([f.systemConfig, f.inbox, 3000, 8191]);
			const commitProof = encodeOPBatchInboxCommitProof({
				l1Header: f.l1Header,
				txIndex: f.txIndex,
				txProof: f.txProof,
				blobIndex: f.blobIndex,
				commitment: f.commitment,
				fieldElements: f.fieldElements,
				blobProofs: f.proofs,
				l2Header: f.l2Header,
			});
			const root = await l1.readContract({
				address: verifier,
				abi: artifact("OPBatchInboxVerifier.sol", "OPBatchInboxVerifier").abi,
				functionName: "verifyStorageRoot",
				args: [commitProof, f.registrar, encodeMPTProof(f.accountProof)],
			});
			expect(root).toBe(f.storageHash);
		}, 120_000);
	}
});
