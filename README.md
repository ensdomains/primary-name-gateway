# primary-name-gateway

Trustless L1 resolution of ENS primary names stored on L2s, without an archive node at request time.

Each L2 has a reverse registrar holding its [ENSIP-19](https://docs.ens.domains/ensip/19) primary names. L1 resolves `{addr}.{coinType}.reverse` → `name()` with CCIP-Read: a gateway returns storage proofs of the registrar, and an L1 contract verifies them against the L2's state root as committed on L1.

| chain | coin type | commits | docs |
|---|---|---|---|
| OP Mainnet | `0x8000000a` | dispute games | [docs/optimism.md](docs/optimism.md) |
| Linea | `0x8000e708` | ZK finalizations | [docs/linea.md](docs/linea.md) |

[docs/registrar.md](docs/registrar.md) covers the registrar contract, its storage layouts, and why its storage can be rebuilt from events.

```
 L1 ─ commits ───────────┐                                ┌─ resolve(name, name()) ── L2ReverseResolver ── IL2StorageVerifier ── L1
                         ▼                                │         │ OffchainLookup                   ▲ verify proofs
 L2 ─ registrar events ─► registrar-indexer ── snapshot / patch ──► registrar-gateway (ezccip) ◄──────────────┘
     + account proof        (sqlite + tries per commit)  trie rows   (NodeStore: versioned trie rows, latest 2 valid commits)
```

## How it works

1. **Indexer.** A chain-specific `CommitSource` follows L1 for commits of the L2's state. For each one, the indexer fetches what can't be rebuilt from events while the L2 still has it (at least the registrar's **account proof**), replays the registrar's events into its storage trie up to that block, and refuses the commit if the rebuilt storage root differs from the L2's. It keeps the tries of recent commits and serves them as rows.
2. **Gateway.** It holds the latest valid commits (2 by default) as **versioned trie rows** `(path, version = L2 block) → node` in a `NodeStore`. It bootstraps from a paged `/snapshot`, then only downloads `/patch` rows (what changed between commits). Proofs are built by copying rows, so the gateway has no trie in memory and hashes no nodes (only slot keys, and one root per commit it loads). Its state lives in the store, so a restart resumes with patches.
3. **Resolver.** `L2ReverseResolver` answers `resolve(name, name())` with `OffchainLookup` to the gateway's `proveName(address)`, then verifies the returned `NameProof` through the chain's `IL2StorageVerifier`:
   1. `verifyStorageRoot(commitProof, registrar, accountProof)`: the commit is valid and fresh on L1, and the account proof gives the registrar's storage root.
   2. `verifyStorageValues(storageRoot, slots, proof)`: the name's header slot and its `NameProof.dataSlots` data slots, which must agree with the header's length. Unset slots are proven absent. All slots share one proof, so a verifier can share work between them.

The serving rules are the same on every chain: the gateway serves the newest valid commit that has been valid for at least `GATEWAY_MARGIN_SEC` (so an L1 node that lags slightly still accepts it), and verifiers reject commits older than their `window`. If the gateway's newest commit becomes invalid, it truncates back to its newest valid commit and patches from there. If the indexer no longer has the commit a gateway asks to patch from, the gateway falls back to a snapshot.

## Packages

| package | what |
|---|---|
| [`shared`](packages/shared) | Chain config and deployments, registrar layouts and events, row formats and provers for each trie kind ([trie.ts](packages/shared/src/trie.ts): Merkle-Patricia, [linea.ts](packages/shared/src/linea.ts): Linea), and the indexer ↔ gateway JSON types. |
| [`registrar-indexer`](packages/registrar-indexer) | `RegistrarIndexer` (event replay, commits, tries of retained commits), a `CommitSource` per chain family, SQLite, HTTP API. |
| [`registrar-gateway`](packages/registrar-gateway) | `NodeStore`, `RegistrarGateway` (sync + `proveName`), the ezccip endpoint. The library (`src/index.ts`) is runtime-agnostic; `src/main.ts` is the bun server. |
| [`contracts`](packages/contracts) | `L2ReverseResolver`, `IL2StorageVerifier`, and one verifier per chain family (`OPFaultVerifier`, `LineaVerifier`), deployed per chain and shareable by other resolvers. |

## Gateway storage (`NodeStore`)

`get(path, version)` reads the newest row ≤ version; `floor(prefix, before, version)` finds the greatest live path below a key (Linea exclusion proofs need the key just below a missing one).

| store | use |
|---|---|
| `MemoryNodeStore` | tests, ephemeral |
| `SqlNodeStore` + `bunSqliteAdapter(db)` | the bun server (`GATEWAY_DB`, default `data/gateway-<chain>.sqlite`) |
| `SqlNodeStore` + a Durable Object adapter | `{ exec: (q, ...p) => ctx.storage.sql.exec(q, ...p).toArray(), transaction: (fn) => ctx.storage.transactionSync(fn) }`, with `sync()` driven by an alarm and requests handled with `ezccip.handleRead(sender, data, { protocol: "raw" })`. A snapshot load saves its cursor after each page, so it can continue across alarms. |

## Setup

```sh
bun i
cd packages/contracts && forge build
```

`.env` (see [`.env.sample`](.env.sample)): `DRPC_KEY` and/or `ALCHEMY_KEY`, or `RPC_URL_<chainId>` / `PROOF_RPC_URL_<chainId>`.

## Run

```sh
bun run indexer          # INDEXER_CHAIN=optimism, :8100
bun run gateway          # GATEWAY_CHAIN=optimism, :8200, from INDEXER_URL=http://localhost:8100
bun run indexer:linea    # :8101
bun run gateway:linea    # :8201
```

Indexer API: `GET /status`, `/commits?status=valid&limit=2`, `/commits/:id`, `/snapshot?commit=ID&after=PATH`, `/patch?from=A&to=B`, `/changes?after=&until=`.

Env: `INDEXER_CHAIN`, `INDEXER_PORT`, `INDEXER_DB`, `INDEXER_POLL_MS`, `INDEXER_MAX_ATTEMPTS`, `GATEWAY_CHAIN`, `GATEWAY_PORT`, `GATEWAY_DB`, `GATEWAY_KEEP`, `GATEWAY_MARGIN_SEC`, `GATEWAY_POLL_MS`, plus chain-specific settings in the chain docs.

## Test

- `bun run test` runs the property tests, the offline e2es, and the forge tests.
  - [trie.test.ts](test/trie.test.ts) and [linea.test.ts](test/linea.test.ts): patched rows reproduce the tries exactly, and row-built proofs equal the L2's (`eth_getProof` / `linea_getProof`), checked against merkle-builder.
  - [store.test.ts](test/store.test.ts): both stores (`get` and `floor`) against an unpruned reference.
  - [offline.test.ts](test/offline.test.ts) and [offline-linea.test.ts](test/offline-linea.test.ts): blocksmith with mock L1 contracts and an in-memory L2 ([OP](test/fake-rollup.ts), [Linea](test/fake-linea.ts)), then the real indexer, gateway, verifier and resolver: name updates, invalid or skipped commits, stale commits, and restarts that resume with patches only.
  - forge: unit tests, and [LineaVerifier.t.sol](packages/contracts/test/LineaVerifier.t.sol) on real mainnet `linea_getProof` output.
- `bun run test:mainnet` needs a running indexer (either chain) with a valid commit. It deploys onto an anvil fork of L1 against the real L1 contracts and checks every indexed name.

## License

MIT. Vendored contract libraries are listed in [`packages/contracts/src/lib/README.md`](packages/contracts/src/lib/README.md).
