import {
	type Change,
	type Deployment,
	type InboxDeployment,
	L2_TO_L1_MESSAGE_PASSER,
	type LineaPathProof,
	type OPDeployment,
	REGISTRAR_ABI,
	type RpcBlockHeader,
} from "@primary-name-gateway/shared";
import { type Address, decodeAbiParameters, getAbiItem, type Hex, numberToHex, type PublicClient } from "viem";

// a registrar event before it gets a sequence number
export type RegistrarChange = Omit<Change, "seq">;

export type L2BlockRef = { number: number; timestamp: number };

// What the indexer needs from any L2: the registrar's events (see docs/registrar.md).
export interface ChangeReader {
	// events in [fromBlock, toBlock'] for some toBlock' <= toBlock, in chain order
	getChanges(fromBlock: number, toBlock: number): Promise<{ changes: RegistrarChange[]; toBlock: number }>;
	// the L2's finalized head, if events above it could still reorg (the indexer never syncs past it)
	finalizedBlock?(): Promise<L2BlockRef>;
}

// what an OP output root commits to (and the registrar account under it)
export type BlockWitness = {
	stateRoot: Hex;
	blockHash: Hex;
	messagePasserStorageRoot: Hex;
	accountProof: Hex[]; // registrar account
	storageHash: Hex; // registrar storage root
};

export interface OPL2Reader extends ChangeReader {
	finalizedBlock(): Promise<L2BlockRef>;
	// L2 block with this timestamp (super roots are keyed by timestamp)
	blockAtTimestamp(timestamp: bigint): Promise<number>;
	// must be called while the L2 still has state for `block` (soon after the commit is proposed)
	getBlockWitness(block: number): Promise<BlockWitness>;
}

export interface InboxL2Reader extends ChangeReader {
	finalizedBlock(): Promise<L2BlockRef>;
	// a block's header fields, by number or hash
	header(block: number | Hex): Promise<RpcBlockHeader>;
	// the registrar's account at `block`
	account(block: number): Promise<{ accountProof: Hex[]; storageHash: Hex }>;
}

export interface LineaL2Reader extends ChangeReader {
	// linea_getProof(registrar, [], block).accountProof: only available for recent finalized blocks
	getAccountProof(block: number): Promise<LineaPathProof>;
}

const NAME_CHANGED = getAbiItem({ abi: REGISTRAR_ABI, name: "NameForAddrChanged" });
const OWNERSHIP_TRANSFERRED = getAbiItem({ abi: REGISTRAR_ABI, name: "OwnershipTransferred" });

export class RPCChangeReader implements ChangeReader {
	private logStep: number;
	private maxLogStep: number;
	constructor(
		readonly deployment: Deployment,
		readonly logsClient: PublicClient, // eth_getLogs (large ranges)
		readonly log?: (...args: unknown[]) => void,
	) {
		this.logStep = this.maxLogStep = deployment.l2.logStep ?? 10000;
	}

	get registrar(): Address {
		return this.deployment.L2ReverseRegistrar;
	}

	async getChanges(fromBlock: number, toBlock: number) {
		const events =
			this.deployment.layout.ownerSlot === undefined ? [NAME_CHANGED] : [NAME_CHANGED, OWNERSHIP_TRANSFERRED];
		for (;;) {
			const end = Math.min(toBlock, fromBlock + this.logStep - 1);
			try {
				const logs = await this.logsClient.getLogs({
					address: this.registrar,
					events,
					fromBlock: BigInt(fromBlock),
					toBlock: BigInt(end),
					strict: true,
				});
				logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
				const changes = logs.map((log): RegistrarChange => {
					const at = { block: Number(log.blockNumber), logIndex: log.logIndex };
					if (log.eventName === "OwnershipTransferred") {
						return { ...at, kind: "owner", addr: log.args.newOwner, name: "0x" };
					}
					// raw bytes: names are not necessarily valid UTF-8
					const [name] = decodeAbiParameters([{ type: "bytes" }], log.data);
					return { ...at, kind: "name", addr: log.args.addr, name };
				});
				// sparse again after a dense stretch: grow back
				if (logs.length < 100 && this.logStep < this.maxLogStep)
					this.logStep = Math.min(this.maxLogStep, this.logStep * 2);
				return { changes, toBlock: end };
			} catch (err) {
				// range too large or too many results (providers cap results, eg. drpc at 20000): shrink and retry
				if (this.logStep <= 1) throw err;
				// a fixed range limit (eg. infura: "exceeds limit of 10000"): never grow past it
				const limit = /limit of (\d+)/.exec(String(err instanceof Error ? err.message : err))?.[1];
				if (limit) this.maxLogStep = Math.max(1, Math.min(this.maxLogStep, Number(limit)));
				this.logStep = Math.min(this.logStep >> 1, this.maxLogStep);
				this.log?.(`getLogs failed, step = ${this.logStep}`);
			}
		}
	}
}

export class RPCOPReader extends RPCChangeReader implements OPL2Reader {
	constructor(
		override readonly deployment: OPDeployment,
		logsClient: PublicClient,
		readonly proofClient: PublicClient, // eth_getProof at historical blocks (archive)
		log?: (...args: unknown[]) => void,
	) {
		super(deployment, logsClient, log);
	}

	async finalizedBlock(): Promise<L2BlockRef> {
		const b = await this.logsClient.getBlock({ blockTag: "finalized" });
		return { number: Number(b.number), timestamp: Number(b.timestamp) };
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

	async getBlockWitness(block: number): Promise<BlockWitness> {
		const blockNumber = BigInt(block);
		const [b, messagePasser, registrar] = await Promise.all([
			this.proofClient.getBlock({ blockNumber }),
			this.proofClient.getProof({ address: L2_TO_L1_MESSAGE_PASSER, storageKeys: [], blockNumber }),
			this.proofClient.getProof({ address: this.registrar, storageKeys: [], blockNumber }),
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

type LineaGetProof = {
	Method: "linea_getProof";
	Parameters: [Address, Hex[], Hex];
	ReturnType: { accountProof: LineaPathProof };
};

export class RPCLineaReader extends RPCChangeReader implements LineaL2Reader {
	constructor(
		deployment: Deployment,
		logsClient: PublicClient,
		readonly proofClient: PublicClient, // linea_getProof (Shomei)
		log?: (...args: unknown[]) => void,
	) {
		super(deployment, logsClient, log);
	}

	async getAccountProof(block: number): Promise<LineaPathProof> {
		const { accountProof } = await this.proofClient.request<LineaGetProof>({
			method: "linea_getProof",
			params: [this.registrar, [], numberToHex(block)],
		});
		return accountProof;
	}
}

export class RPCInboxReader extends RPCChangeReader implements InboxL2Reader {
	constructor(
		override readonly deployment: InboxDeployment,
		logsClient: PublicClient,
		readonly proofClient: PublicClient, // eth_getProof
		log?: (...args: unknown[]) => void,
	) {
		super(deployment, logsClient, log);
	}

	async finalizedBlock(): Promise<L2BlockRef> {
		const b = await this.logsClient.getBlock({ blockTag: "finalized" });
		return { number: Number(b.number), timestamp: Number(b.timestamp) };
	}

	async header(block: number | Hex): Promise<RpcBlockHeader> {
		const byHash = typeof block === "string";
		const h = (await this.proofClient.request({
			method: byHash ? "eth_getBlockByHash" : "eth_getBlockByNumber",
			params: [byHash ? block : numberToHex(block), false],
		} as never)) as RpcBlockHeader | null;
		if (!h) throw new Error(`no L2 block ${block}`);
		return h;
	}

	async account(block: number): Promise<{ accountProof: Hex[]; storageHash: Hex }> {
		const { accountProof, storageHash } = await this.proofClient.getProof({
			address: this.registrar,
			storageKeys: [],
			blockNumber: BigInt(block),
		});
		return { accountProof, storageHash };
	}
}
