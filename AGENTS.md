# AGENTS.md

Notes for coding agents working in this repo. Read [README.md](README.md) first for the architecture.

## Layout

- `packages/shared`: chain config, registrar layout, OP game decoding, indexer ↔ gateway types, and `trie.ts` (trie rows, diffs, row-walked proofs).
- `packages/registrar-indexer`: L1 game discovery, L2 event replay into merkle-builder tries, SQLite (`bun:sqlite`), HTTP API.
- `packages/registrar-gateway`: `NodeStore` (versioned trie rows), `RegistrarGateway` (sync + `proveName`), ezccip endpoint. `src/index.ts` must stay runtime-agnostic (no bun/node imports) so it can run in a Cloudflare Durable Object; bun-only code lives in `src/main.ts` and `src/sqlite.ts`.
- `packages/contracts`: Foundry project. `L2ReverseResolver` (ENSIP-10 + CCIP-Read), `OPFaultVerifier` (`IL2StorageVerifier` for OP Stack fault-proof chains). `src/lib/optimism` and `src/lib/unruggable` are vendored; see `src/lib/README.md` before changing them.
- `test/`: bun tests, including the fake OP rollup used by the offline e2e.

## Commands

```sh
bun i                      # bunfig.toml uses the hoisted linker; don't change it
bun run check              # tsc
bun run test               # forge build + trie/store/offline bun tests + forge tests
bun run test:mainnet       # needs `bun run indexer` running with a valid commit, and .env keys
```

Run `bun run check` and `bun run test` before finishing a change.

## Invariants

- The gateway never builds a trie or hashes nodes, apart from one keccak per commit to check the root row. Anything that needs hashing belongs in the indexer.
- Trie rows are `(absolute nibble path, RLP node)`; `null` marks a removed node. `diffRows` relies on merkle-builder's copy-on-write tries (unchanged subtree = same object), so don't clone tries between commits.
- The indexer refuses a commit whose replayed `storageHash` differs from `eth_getProof`. Keep that check.
- `NodeStore` methods are synchronous; `put` is atomic. Keep `MemoryNodeStore` and `SqlNodeStore` behaviour identical (`test/store.test.ts` compares them to a reference model).
- The registrar layout is `mapping(address => string)` at slot 0. Names are raw bytes; long strings use `ceil(len/32)` data slots at `keccak(slot)`.
- `validAt` is wall-clock time; game age and lookback use L1 block time.

## Style

- TypeScript: ESM, tabs, viem for encoding/RPC, explicit `.js` extensions on relative imports.
- Solidity 0.8.30, 4-space indent, custom errors.
- Keep comments short and about why, not what.

## Secrets

`.env` holds RPC keys and is gitignored. Never print, log or commit them; log RPC URLs through `redactURL`.
