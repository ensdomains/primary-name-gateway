# primary-name-gateway

[![CI](https://github.com/ensdomains/primary-name-gateway/actions/workflows/main.yml/badge.svg)](https://github.com/ensdomains/primary-name-gateway/actions/workflows/main.yml)

Trustless L1 resolution of ENS primary names stored on L2s, without an archive node at request time.

Each L2 has a reverse registrar holding its [ENSIP-19](https://docs.ens.domains/ensip/19) primary names. L1 resolves `{addr}.{coinType}.reverse` → `name()` with CCIP-Read: a gateway returns storage proofs of the registrar, and an L1 contract verifies them against the L2's state root as committed on L1.

| chain | coin type | commits | docs |
|---|---|---|---|
| OP Mainnet | `0x8000000a` | dispute games (super root) | [docs/optimism.md](docs/optimism.md) |
| Base | `0x80002105` | dispute games (output root, `AggregateVerifier`) | [docs/base.md](docs/base.md) |
| Linea | `0x8000e708` | ZK finalizations | [docs/linea.md](docs/linea.md) |

[docs/registrar.md](docs/registrar.md) covers the registrar contract, its storage layouts, and why its storage can be rebuilt from events.

Research: [docs/op-batch-inbox.md](docs/op-batch-inbox.md) proves OP Stack blocks from the batcher's posts instead of dispute games (minutes instead of days, trusting the batcher key). It works end to end on Base and OP Mainnet (`base-inbox`, `optimism-inbox`); nothing is deployed.

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 400}}}%%
flowchart TD
    L1c["L1: commits"] --> indexer
    L2["L2: registrar events + account proof"] --> indexer
    indexer["registrar-indexer — SQLite: events, commits, trie rows"] -->|"snapshot / patch"| gateway
    gateway["registrar-gateway (ezccip) — latest 2 valid commits"] -->|"NameProof"| resolver
    client["resolve(name, name())"] --> resolver
    resolver["L2ReverseResolver (L1)"] -.->|"OffchainLookup: proveName(addr)"| gateway
    resolver -->|"verify proofs"| verifier["IL2StorageVerifier (L1)"]
    verifier -.->|"commit is valid"| L1c
```

## How it works

1. **Indexer.** A chain-specific `CommitSource` follows L1 for commits of the L2's state. For each one, the indexer fetches what can't be rebuilt from events while the L2 still has it (at least the registrar's **account proof**), replays the registrar's events into its storage trie up to that block, and refuses the commit if the rebuilt storage root differs from the L2's. It keeps the tries of recent commits and serves them as rows.
2. **Gateway.** It holds the latest valid commits (2 by default) as **versioned trie rows** `(path, version = L2 block) → node` in a `NodeStore`. For OP Stack chains the rows are chunks: each node above depth 4 is its own row, and deeper nodes are grouped by their 4-nibble prefix, so Base is about 70,000 rows instead of 5M ([optimism.md](docs/optimism.md#chunks)). It bootstraps from a paged `/snapshot`, then only downloads `/patch` rows (what changed between commits). Proofs are built by copying rows, so the gateway has no trie in memory and hashes no nodes (only slot keys, and one root per commit it loads). Its state lives in the store, so a restart resumes with patches.
3. **Resolver.** `L2ReverseResolver` answers `resolve(name, name())` with `OffchainLookup` to the gateway's `proveName(address)`, then verifies the returned `NameProof` through the chain's `IL2StorageVerifier`:
   1. `verifyStorageRoot(commitProof, registrar, accountProof)`: the commit is valid and fresh on L1, and the account proof gives the registrar's storage root.
   2. `verifyStorageValues(storageRoot, slots, proof)`: the name's header slot and its `NameProof.dataSlots` data slots, which must agree with the header's length. Unset slots are proven absent. All slots share one proof, so a verifier can share work between them.

The serving rules are the same on every chain: the gateway serves the newest valid commit that has been valid for at least `GATEWAY_MARGIN_SEC` (so an L1 node that lags slightly still accepts it), and verifiers reject commits that are too stale (`maxSequenceLag` behind the anchor on OP, `maxBlockLag` L2 blocks on Linea, `maxBlockLag` L1 blocks for the batch inbox): otherwise a gateway could prove a name from before it was changed. If the gateway's newest commit becomes invalid, it truncates back to its newest valid commit and patches from there. If the indexer no longer has the commit a gateway asks to patch from, the gateway falls back to a snapshot.

## Packages

| package | what |
|---|---|
| [`shared`](packages/shared) | Chain config and deployments, registrar layouts and events, row formats and provers for each trie kind ([trie.ts](packages/shared/src/trie.ts): Merkle-Patricia, [linea.ts](packages/shared/src/linea.ts): Linea), the indexer ↔ gateway JSON types, and the batch inbox references ([brotli.ts](packages/shared/src/brotli.ts), [op-batch.ts](packages/shared/src/op-batch.ts)). |
| [`registrar-indexer`](packages/registrar-indexer) | `RegistrarIndexer` (event replay, commits, tries of retained commits, kept as versioned rows in SQLite for OP Stack chains), a `CommitSource` per chain family (dispute games, Linea finalizations, batcher blobs), HTTP API. |
| [`registrar-gateway`](packages/registrar-gateway) | `NodeStore`, `RegistrarGateway` (sync + `proveName`), the [ezccip](https://github.com/adraffy/ezccip.js) endpoint. The library (`src/index.ts`) is runtime-agnostic; `src/main.ts` is the bun server. |
| [`contracts`](packages/contracts) | `L2ReverseResolver`, `IL2StorageVerifier`, and one verifier per chain family (`OPFaultVerifier`, `LineaVerifier`; research: `OPBatchInboxVerifier`), deployed per chain and shareable by other resolvers. |

## Gateway storage (`NodeStore`)

Rows are keyed by a string: a [chunk](docs/optimism.md#chunks) key for OP Stack chains, a Linea row path for Linea. `get(key, version)` reads the newest row ≤ version; `floor(prefix, before, version)` finds the greatest live path below a key (Linea exclusion proofs need the key just below a missing one).

| store | use |
|---|---|
| `MemoryNodeStore` | tests, ephemeral |
| `SqlNodeStore` + `bunSqliteAdapter(db)` | the bun server (`GATEWAY_DB`, default `data/gateway-<chain>.sqlite`) |
| `SqlNodeStore` + a Durable Object adapter | a Cloudflare Durable Object per chain: `ctx.storage.sql` as the store, `sync()` on an alarm, requests through `createFetchHandler(createEZCCIP(gateway))`. See [docs/durable-objects.md](docs/durable-objects.md) for how it fits, a sketch, and the limits that matter. |

## Setup

```sh
git clone --recursive https://github.com/ensdomains/primary-name-gateway   # or: git submodule update --init (forge-std)
bun i
cd packages/contracts && forge build
```

`.env` (see [`.env.sample`](.env.sample)): any of `DRPC_KEY`, `ALCHEMY_KEY`, `INFURA_KEY`, or `RPC_URL_<chainId>` / `PROOF_RPC_URL_<chainId>`. [docs/rpc.md](docs/rpc.md) covers which provider is used for what, their known limits, and every environment variable.

## Run

```sh
bun run indexer          # INDEXER_CHAIN=optimism, :8100
bun run gateway          # GATEWAY_CHAIN=optimism, :8200, from INDEXER_URL=http://localhost:8100
bun run indexer:linea    # :8101
bun run gateway:linea    # :8201
bun run indexer:base     # :8102
bun run gateway:base     # :8202
bun run indexer:base-inbox  # :8103 (research: docs/op-batch-inbox.md)
bun run gateway:base-inbox  # :8203
```

Indexer API: `GET /status` (`l2ChainId`, `l1ChainId`, commit kind, L2 block time, `minAgeSec`, sync position, commit counts), `/commits?status=valid&limit=2`, `/commits/:id`, `/snapshot?commit=ID&after=KEY`, `/patch?from=A&to=B`, `/changes?after=&until=`. `/snapshot` and `/patch` serve rows in the layout their `x-row-format` header names (OP Stack: [chunks](docs/optimism.md#chunks)). Responses are JSON, gzipped when the client accepts it: a Base `/snapshot` page (50,000 nodes in about 700 chunks) is about 9 MB, or 3.9 MB gzipped.

Env: see [docs/rpc.md#environment](docs/rpc.md#environment).

## Test

`bun run test` runs every offline group below. [CI](.github/workflows/main.yml) runs `bun run check`, `bun run lint`, and each group as its own job, so a failed one can be re-run alone. The anvil-based groups use [blocksmith](https://github.com/adraffy/blocksmith.js).

| script | what | needs |
|---|---|---|
| `test:unit` | the TypeScript tests below that need no chain | |
| `test:contracts` | forge tests | Foundry |
| `test:e2e` | the offline end-to-end tests, and `inline-node` | anvil |
| `test:inbox` | batch inbox: Solidity against the TypeScript references, and the verifier on mainnet fixtures | anvil |
| `test:kzg` | the indexer's KZG proofs against the precompile | anvil; downloads the KZG trusted setup once |
| `test:mainnet`, `test:fork` | against L1 mainnet forks (not in CI) | RPC keys, archive state |

- The tests:
  - Tries: [trie.test.ts](test/trie.test.ts) (the indexer's SQL row log against merkle-builder's `EthStorage` at every kept version: snapshots, patches, proofs, rebuilt out-of-order versions), [inline-node.test.ts](test/inline-node.test.ts) (nodes under 32 bytes, through to the verifier), [linea.test.ts](test/linea.test.ts) (Linea rows and multiproofs against merkle-builder's `LineaStorage`), [store.test.ts](test/store.test.ts) (both `NodeStore`s against an unpruned reference).
  - RPC: [l2.test.ts](test/l2.test.ts) (`eth_getLogs` range limits).
  - End to end: [offline.test.ts](test/offline.test.ts), [offline-base.test.ts](test/offline-base.test.ts), [offline-minage.test.ts](test/offline-minage.test.ts) and [offline-linea.test.ts](test/offline-linea.test.ts) run mock L1 contracts and an in-memory L2 ([OP](test/fake-rollup.ts), [Linea](test/fake-linea.ts)) through the real indexer, gateway, verifier and resolver: name updates, invalid or skipped commits, stale commits, out-of-order games, and restarts.
  - Batch inbox: [brotli.test.ts](test/brotli.test.ts), [brotli-sol.test.ts](test/brotli-sol.test.ts), [op-batch-sol.test.ts](test/op-batch-sol.test.ts), [op-batch-verifier.test.ts](test/op-batch-verifier.test.ts) and [kzg.test.ts](test/kzg.test.ts) ([docs/op-batch-inbox.md](docs/op-batch-inbox.md)).
  - forge: unit tests, [LineaVerifier.t.sol](packages/contracts/test/LineaVerifier.t.sol) on real `linea_getProof` output, and [BrotliPrefix.t.sol](packages/contracts/test/BrotliPrefix.t.sol) (gas).
- `bun run test:mainnet` needs a running indexer (any chain) with a valid commit and RPC keys. It deploys the chain's verifier and the resolver on an anvil fork of L1 mainnet, resolves names through CCIP-Read, and checks every indexed name (or a sample of `MAINNET_SAMPLE`, with every long name) against the registrar.
- `bun run test:fork` runs `OPBatchInboxVerifier` on L1 mainnet forks (archive RPC).
- `bun run prove <address> <chain>` proves one address's primary name through a gateway (the port of `gateway:<chain>`, or `--gateway URL`). It only talks to the gateway, as a client would, so it works against any gateway, including one whose indexer is stopped or out of reach. It deploys the chain's verifier and a resolver pointing at the gateway on a blocksmith fork of L1, resolves the name through CCIP-Read, reads the L2 block from the proof's commit proof, and prints:

  ```
  name      "quelburr.base.eth"
  gateway   23 ms, 25,088-byte response
  verify    12,975,804 gas (verifyName on the L1 fork)
  proof     L2 block 61,419,983 (inbox: batch in L1 block 26,480,951)
  finalized L2 block 61,421,724: the proof is 1,741 blocks (6m) behind
  L2        matches L2ReverseRegistrar.nameForAddr at L2 block 61,419,983
  ```

  For OP Stack fault proofs, pass `--min-age SEC` when the indexer accepts games early (its `INDEXER_MIN_AGE_SEC`).

## References

- [ENSIP-19](https://docs.ens.domains/ensip/19) (multichain primary names), [ENSIP-10](https://docs.ens.domains/ensip/10) (wildcard resolution), [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) (CCIP-Read)
- [merkle-builder](https://github.com/ensdomains/merkle-builder): rebuilds storage tries from events (Merkle-Patricia and Linea)
- [ezccip.js](https://github.com/adraffy/ezccip.js): the CCIP-Read endpoint

## License

MIT. Vendored contract libraries are listed in [`packages/contracts/src/lib/README.md`](packages/contracts/src/lib/README.md).
