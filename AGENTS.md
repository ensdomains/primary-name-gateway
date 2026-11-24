# AGENTS.md

Notes for coding agents working in this repo. Read [README.md](README.md) first for the architecture, [docs/registrar.md](docs/registrar.md) for the registrar contract, [docs/optimism.md](docs/optimism.md) / [docs/base.md](docs/base.md) / [docs/linea.md](docs/linea.md) / [docs/arbitrum.md](docs/arbitrum.md) for the chain-specific parts, [docs/op-batch-inbox.md](docs/op-batch-inbox.md) for the batch inbox research, [docs/durable-objects.md](docs/durable-objects.md) for running the gateway in a Cloudflare Durable Object, and [docs/rpc.md](docs/rpc.md) for RPC providers and environment variables.

## Layout

- `packages/shared`: chain config and deployments (`chains.ts`), registrar layouts and events (`registrar.ts`), OP game decoding and proof encoders (`op.ts`), Merkle-Patricia rows (`trie.ts`), Linea sparse Merkle rows and multiproofs (`linea.ts`), indexer ↔ gateway types, block headers (`header.ts`), the batch inbox references: partial brotli (`brotli.ts`), blob data, frames, batch prefixes and commit proofs (`op-batch.ts`), Arbitrum BoLD assertions and commit proofs (`arbitrum.ts`), and the services' log (`log.ts`: info, `ok`, `warn`, `error`; colored on a terminal or with `FORCE_COLOR`).
- `packages/registrar-indexer`: `RegistrarIndexer` (event replay, commits, tries of retained commits) with a `CommitSource` per chain family (`op.ts`: dispute games, `linea.ts`: finalizations, `inbox.ts`: batcher blobs, with `kzg.ts`, `arbitrum.ts`: BoLD assertions), trie backends (`tries.ts`: `MPTIndexerTrie` = merkle-builder `EthRowStorage` over `SqlRowLog` in `sql-row-log.ts`, `LineaIndexerTrie` + in-memory `RowLog`), SQLite (`bun:sqlite`), HTTP API.
- `packages/registrar-gateway`: `NodeStore` (versioned trie rows with `get` and `floor`), `RegistrarGateway` (sync + `proveName`, per commit kind; its deployment, layout included, comes from the indexer's `/status`, and its store records it), `createGatewayHandler`: `GET /status`, JSON-RPC at `/rpc` (`rpc.ts`: `eth_getProof` / `eth_getStorageAt` for the registrar, [docs/gateway-rpc.md](docs/gateway-rpc.md)), and CCIP-Read (ezccip) on every other path. `src/index.ts` must stay runtime-agnostic (no bun/node imports) so it can run in a Cloudflare Durable Object ([docs/durable-objects.md](docs/durable-objects.md)); bun-only code lives in `src/main.ts` and `src/sqlite.ts`.
- `packages/contracts`: Foundry project. `L2ReverseResolver` (ENSIP-10 + CCIP-Read), `IL2StorageVerifier` implementations `op/OPFaultVerifier`, `linea/LineaVerifier` (+ `linea/LineaTrie` multiproofs) and `arbitrum/ArbitrumVerifier` (BoLD assertion chains, [docs/arbitrum.md](docs/arbitrum.md)). `op/OPBatchInboxVerifier` (+ `brotli/BrotliPrefix`, `op/OPBlob`, `op/OPBatchPrefix`, `op/OPBatchInbox`) is research for a verifier from batcher posts ([docs/op-batch-inbox.md](docs/op-batch-inbox.md)). `src/lib/` is vendored; see `src/lib/README.md` before changing it.
- `test/`: bun tests, including the fake OP rollup, Linea and Arbitrum L2s used by the offline e2es. Mainnet fixtures live in `packages/contracts/test/fixtures/` (forge reads them too).
- `scripts/`: `prove.ts` proves one name through a gateway on an L1 fork, reading the L2 block from the proof (`verifiers.ts`: the verifier deploy arguments, shared with `test:mainnet`); `linea-fixture.ts`, `op-batch-fixture.ts` and `arbitrum-fixture.ts` refresh the mainnet fixtures; `op-batch-cost.ts` sizes the brotli decoding.
- `.github/workflows/main.yml`: CI. Offline only (no RPC keys), one job per test group so a failed group can be re-run alone. A test that needs RPC access belongs in `test:mainnet` / `test:fork`, not in `bun run test`.

## Commands

```sh
bun i                      # bunfig.toml uses the hoisted linker; don't change it
bun run check              # tsc
bun run lint               # biome (lint:fix applies fixes and formatting)
bun run test               # every offline group: test:unit, test:contracts, test:e2e, test:inbox, test:kzg (CI runs each as a job)
bun run test:mainnet       # needs a running indexer (any chain, INDEXER_URL, default :8100) with a valid commit, and .env keys
bun run test:fork          # OPBatchInboxVerifier on L1 mainnet forks (archive RPC, fixtures < 8191 blocks old)
bun run prove <addr> base  # one name through a running gateway, verified on an L1 fork (scripts/prove.ts)
bun run indexer:optimism   # / gateway:optimism on :8100 / :8200; linea :8101 / :8201, base :8102 / :8202, base-inbox :8103 / :8203, arbitrum :8104 / :8204
```

Run `bun run check`, `bun run lint` and `bun run test` before finishing a change.

## Invariants

- The gateway never builds a trie or hashes nodes: it only hashes slot keys (keccak / Poseidon2) and the root row of each commit it loads. Anything else that needs hashing belongs in the indexer.
- OP rows are `(absolute nibble path, RLP node)`; Linea rows are described at the top of `shared/src/linea.ts`. `null` marks a removed row. OP rows are merkle-builder's row format (`EthRowStorage`, `getProofFromRows`): every node has a row, inlined ones included. The indexer serves them, and the gateway stores them, as chunks (`chunkId`, limbs in `shared/src/trie.ts`, built by `registrar-indexer/src/chunks.ts`); `test/chunks.test.ts` checks them against merkle-builder.
- The OP trie is persistent (`trie_head` / `trie_history`, `state.trieSeq` = last change applied). Versions are change seqs; only the versions of retained commits stay readable, so don't read a version that isn't kept.
- The indexer refuses a commit whose replayed storage root differs from the L2's account proof (`addCommit`). Keep that check.
- The registrar's storage is a fold over its events; the layout (`namesSlot`, `ownerSlot`) is a parameter everywhere, never hard-coded.
- Linea: apply each L2 block's changes together (`LineaStorageTrie.commit()`), in `hkey` order, like Shomei. Leaf indices depend on it.
- Linea account proofs must be fetched when the finalization is seen: Shomei forgets old blocks within about a day.
- `LineaTrie.find` requires canonical `hKey` limbs for exclusion: Poseidon2 reduces inputs mod p. Don't remove it (`test_exclusionAliasedKey`).
- `BrotliPrefix.sol` is a port of `shared/src/brotli.ts`, and `op/OPBlob.sol`, `op/OPBatchPrefix.sol` and `op/OPBatchInbox.sol` port `shared/src/op-batch.ts`: change them together. `test/brotli-sol.test.ts` and `test/op-batch-sol.test.ts` compare them.
- `NodeStore` methods are synchronous; `put` is atomic. Keep `MemoryNodeStore` and `SqlNodeStore` behaviour identical (`test/store.test.ts` compares them to a reference model).
- `SqlNodeStore.prune` runs on every gateway sync, so it must stay incremental: after the first prune, `put` records written paths in `trie_dirty` and prune only looks at those. `test/store.test.ts` checks that nothing a full prune would drop is left behind.
- `validAt` is wall-clock time; OP game age and lookback use L1 block time.

## Style

- TypeScript: ESM, viem for encoding/RPC, explicit `.js` extensions on relative imports; formatting and import order are Biome's (`biome.json`).
- Solidity 0.8.33 with via-IR, 4-space indent, custom errors.
- Don't vendor AGPL code (Linea's `SparseMerkleProof.sol` is AGPL; `LineaTrie.sol` is an independent implementation). Vendored files keep their header and get an entry in `packages/contracts/src/lib/README.md`.
- Keep comments short and about why, not what.

## Secrets

`.env` holds RPC keys and is gitignored. Never print, log or commit them; log RPC URLs through `redactURL`.
