// The verifier each deployment's L2ReverseResolver uses, with the arguments test:mainnet and
// `bun run prove` deploy it with on an L1 fork.
import type { Deployment } from "@primary-name-gateway/shared";

export function verifierContract(d: Deployment, minAgeSec = 0): { contract: string; args: unknown[] } {
	switch (d.kind) {
		case "op":
			return {
				contract: "OPFaultVerifier",
				args: [
					d.AnchorStateRegistry,
					d.l2.id,
					86400, // maxSequenceLag: super root games: seconds (1 day); output root games: blocks (Base: 4.8 h)
					minAgeSec, // as the indexer's INDEXER_MIN_AGE_SEC
				],
			};
		case "inbox":
			return {
				contract: "OPBatchInboxVerifier",
				args: [
					d.SystemConfig,
					d.BatchInbox,
					3000, // maxOriginLag: L1 blocks (sequencing window 3600)
					8191, // maxBlockLag: what EIP-2935 keeps
				],
			};
		case "linea":
			return {
				contract: "LineaVerifier",
				args: [
					d.LineaRollup,
					100000, // maxBlockLag: L2 blocks (a few days)
				],
			};
	}
}
