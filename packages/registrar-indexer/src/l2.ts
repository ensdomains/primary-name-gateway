import {
	L2_TO_L1_MESSAGE_PASSER,
	type OPDeployment,
	REGISTRAR_ABI,
} from "@primary-name-gateway/shared";
import { type Address, decodeAbiParameters, getAbiItem, type Hex, type PublicClient } from "viem";

export type NameChange = { block: number; logIndex: number; addr: Address; name: Hex };

// what an output root commits to (and the registrar account under it)
export type BlockWitness = {
	stateRoot: Hex;
	blockHash: Hex;
	messagePasserStorageRoot: Hex;
	accountProof: Hex[]; // registrar account
	storageHash: Hex; // registrar storage root
};

// Everything the indexer needs from the L2.
// RPCL2Reader talks to a real chain; tests use an in-memory rollup.
export interface L2Reader {
	// L2 block with this timestamp (super roots are keyed by timestamp)
	blockAtTimestamp(timestamp: bigint): Promise<number>;
	// NameForAddrChanged events in [fromBlock, toBlock'] for some toBlock' <= toBlock, in chain order
	getNameChanges(fromBlock: number, toBlock: number): Promise<{ changes: NameChange[]; toBlock: number }>;
	// must be called while the L2 still has state for `block` (soon after the commit is proposed)
	getBlockWitness(block: number): Promise<BlockWitness>;
}

const NAME_CHANGED = getAbiItem({ abi: REGISTRAR_ABI, name: "NameForAddrChanged" });

export class RPCL2Reader implements L2Reader {
	private logStep: number;
	constructor(
		readonly deployment: OPDeployment,
		readonly logsClient: PublicClient, // eth_getLogs (large ranges)
		readonly proofClient: PublicClient, // eth_getProof at historical blocks (archive)
		readonly log?: (...args: unknown[]) => void,
	) {
		this.logStep = deployment.l2.logStep ?? 10000;
	}

	async blockAtTimestamp(timestamp: bigint): Promise<number> {
		const head = await this.logsClient.getBlock({ blockTag: "latest" });
		const ts = Number(timestamp);
		const n = Number(head.number) - Math.floor((Number(head.timestamp) - ts) / this.deployment.l2BlockTime);
		const block = await this.logsClient.getBlock({ blockNumber: BigInt(n) });
		if (Number(block.timestamp) !== ts) {
			throw new Error(`no L2 block at timestamp ${ts} (block ${n} has ${block.timestamp})`);
		}
		return n;
	}

	async getNameChanges(fromBlock: number, toBlock: number) {
		for (;;) {
			const end = Math.min(toBlock, fromBlock + this.logStep - 1);
			try {
				const logs = await this.logsClient.getLogs({
					address: this.deployment.L2ReverseRegistrar,
					event: NAME_CHANGED,
					fromBlock: BigInt(fromBlock),
					toBlock: BigInt(end),
					strict: true,
				});
				logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
				const changes = logs.map((log) => {
					// raw bytes: names are not necessarily valid UTF-8
					const [name] = decodeAbiParameters([{ type: "bytes" }], log.data);
					return { block: Number(log.blockNumber), logIndex: log.logIndex, addr: log.args.addr, name };
				});
				return { changes, toBlock: end };
			} catch (err) {
				if (this.logStep <= 1000) throw err;
				this.logStep >>= 1; // range too large (or too many results): shrink and retry
				this.log?.(`getLogs failed, step = ${this.logStep}`);
			}
		}
	}

	async getBlockWitness(block: number): Promise<BlockWitness> {
		const blockNumber = BigInt(block);
		const [b, messagePasser, registrar] = await Promise.all([
			this.proofClient.getBlock({ blockNumber }),
			this.proofClient.getProof({ address: L2_TO_L1_MESSAGE_PASSER, storageKeys: [], blockNumber }),
			this.proofClient.getProof({ address: this.deployment.L2ReverseRegistrar, storageKeys: [], blockNumber }),
		]);
		return {
			stateRoot: b.stateRoot,
			blockHash: b.hash,
			messagePasserStorageRoot: messagePasser.storageHash,
			accountProof: registrar.accountProof,
			storageHash: registrar.storageHash,
		};
	}
}
