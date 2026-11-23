# AGENTS.md

Notes for coding agents working in this repo. Read [README.md](README.md) first for the architecture, [docs/registrar.md](docs/registrar.md) for the registrar contract, and [docs/optimism.md](docs/optimism.md) / [docs/base.md](docs/base.md) / [docs/linea.md](docs/linea.md) for the chain-specific parts.

## Layout

- `packages/shared`: chain config and deployments (`chains.ts`), registrar layouts and events (`registrar.ts`), OP game decoding and proof encoders (`op.ts`), Merkle-Patricia rows (`trie.ts`), Linea sparse Merkle rows and multiproofs (`linea.ts`), indexer ↔ gateway types.
- `packages/registrar-indexer`: `RegistrarIndexer` (event replay, commits, tries of retained commits) with a `CommitSource` per chain family (`op.ts`: dispute games, `linea.ts`: finalizations), trie backends (`tries.ts`: `MPTIndexerTrie`, `LineaIndexerTrie` + `RowLog`), SQLite (`bun:sqlite`), HTTP API.
- `packages/registrar-gateway`: `NodeStore` (versioned trie rows with `get` and `floor`), `RegistrarGateway` (sync + `proveName`, per commit kind), ezccip endpoint. `src/index.ts` must stay runtime-agnostic (no bun/node imports) so it can run in a Cloudflare Durable Object; bun-only code lives in `src/main.ts` and `src/sqlite.ts`.
- `packages/contracts`: Foundry project. `L2ReverseResolver` (ENSIP-10 + CCIP-Read), `IL2StorageVerifier` implementations `op/OPFaultVerifier` and `linea/LineaVerifier` (+ `linea/LineaTrie` multiproofs). `src/lib/` is vendored; see `src/lib/README.md` before changing it.
- `test/`: bun tests, including the fake OP rollup and fake Linea used by the offline e2es.
- `scripts/linea-fixture.ts`: refreshes the mainnet fixture used by the forge tests.

## Commands

```sh
bun i                      # bunfig.toml uses the hoisted linker; don't change it
bun run check              # tsc
bun run lint               # biome (lint:fix applies fixes and formatting)
bun run test               # forge build + property tests + both offline e2es + forge tests
bun run test:mainnet       # needs a running indexer (either chain) with a valid commit, and .env keys
bun run indexer:linea      # / gateway:linea: Linea on :8101 / :8201 (indexer:base / gateway:base: Base on :8102 / :8202)
```

Run `bun run check`, `bun run lint` and `bun run test` before finishing a change.

## Invariants

- The gateway never builds a trie or hashes nodes: it only hashes slot keys (keccak / Poseidon2) and the root row of each commit it loads. Anything else that needs hashing belongs in the indexer.
- OP rows are `(absolute nibble path, RLP node)`; Linea rows are described at the top of `shared/src/linea.ts`. `null` marks a removed row. `diffRows` relies on merkle-builder's copy-on-write tries (unchanged subtree = same object), so don't clone OP tries between commits.
- The indexer refuses a commit whose replayed storage root differs from the L2's account proof (`addCommit`). Keep that check.
- The registrar's storage is a fold over its events; the layout (`namesSlot`, `ownerSlot`) is a parameter everywhere, never hard-coded.
- Linea: apply each L2 block's changes together (`LineaStorageTrie.commit()`), in `hkey` order, like Shomei. Leaf indices depend on it.
- Linea account proofs must be fetched when the finalization is seen: Shomei forgets old blocks within about a day.
- `LineaTrie.find` requires canonical `hKey` limbs for exclusion: Poseidon2 reduces inputs mod p. Don't remove it (`test_exclusionAliasedKey`).
- `NodeStore` methods are synchronous; `put` is atomic. Keep `MemoryNodeStore` and `SqlNodeStore` behaviour identical (`test/store.test.ts` compares them to a reference model).
- `validAt` is wall-clock time; OP game age and lookback use L1 block time.

## Style

- TypeScript: ESM, viem for encoding/RPC, explicit `.js` extensions on relative imports; formatting and import order are Biome's (`biome.json`).
- Solidity 0.8.33 with via-IR, 4-space indent, custom errors.
- Don't vendor AGPL code (Linea's `SparseMerkleProof.sol` is AGPL; `LineaTrie.sol` is an independent implementation). Vendored files keep their header and get an entry in `packages/contracts/src/lib/README.md`.
- Keep comments short and about why, not what.

## Secrets

`.env` holds RPC keys and is gitignored. Never print, log or commit them; log RPC URLs through `redactURL`.
