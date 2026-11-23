# primary-name-gateway

Trustless L1 resolution of ENS primary names stored in an L2's reverse registrar, without an archive node at request time.

Supported: **OP Mainnet** (coin type `0x8000000a`) and **Linea** (`0x8000e708`). See [docs/registrar.md](docs/registrar.md) for the registrar contract, its storage layouts, and why its storage can be rebuilt from events.

```
 L1 ─ commits (OP games / Linea finalizations) ─┐                ┌─ resolve(name, name()) ── L2ReverseResolver ── IL2StorageVerifier ── L1
                                                ▼                │         │ OffchainLookup                   ▲ verify proofs
 L2 ─ registrar events ─► registrar-indexer ── snapshot / patch ──► registrar-gateway (ezccip) ◄──────────────┘
     + account proof        (sqlite + tries per commit)  trie rows   (NodeStore: versioned trie rows, latest 2 valid commits)
```

## Packages

| package | what |
|---|---|
| [`registrar-indexer`](packages/registrar-indexer) | Follows L1 for commits of the L2's state (a `CommitSource`). For each commit it fetches what can't be rebuilt from events while the L2 still has it (the registrar's **account proof**, and for OP the output root preimage), replays the registrar's events into a storage trie up to that block, and checks the rebuilt storage root against the account proof. Serves an HTTP API. |
| [`registrar-gateway`](packages/registrar-gateway) | Holds the latest valid commits (keeps 2) as **versioned trie rows** `(path, version = L2 block) → node` in a `NodeStore`. It bootstraps from a paged `/snapshot`, then only downloads `/patch` rows. Proofs are produced by copying rows, so the gateway has **no trie in memory and hashes no nodes** (only slot keys, and one root per commit it loads). State lives in the store, so a restart resumes with patches. The library is runtime-agnostic (`src/index.ts`); `src/main.ts` is the bun server using `bun:sqlite`. Answers CCIP-Read `proveName(address)` via [ezccip](https://github.com/namestonehq/ezccip.js). |
| [`contracts`](packages/contracts) | `L2ReverseResolver`: an ENSIP-10 `IExtendedResolver` for `{addr}.{coinType}.reverse` that supports `name()`, does CCIP-Read to the gateway and verifies the response through an `IL2StorageVerifier`: `OPFaultVerifier` (OP Stack fault proofs) or `LineaVerifier` (Linea finalizations). One verifier per chain, shareable by other resolvers. |
| [`shared`](packages/shared) | Chain config, registrar layouts and events, OP game decoding, the Merkle-Patricia (`trie.ts`) and Linea sparse Merkle (`linea.ts`) row formats and provers, and the indexer ↔ gateway JSON types. |

## Chains

| | OP Mainnet | Linea |
|---|---|---|
| commit | dispute game (super root, type 9) | `LineaRollup` `DataFinalizedV3` (ZK proven) |
| valid when | `AnchorStateRegistry.isGameClaimValid(game)`, ~7 days | the L1 block is finalized, ~3h cadence |
| commit id | game index | finalized L2 block |
| state trie | Merkle-Patricia (keccak) | Shomei sparse Merkle trie (Poseidon2) |
| account proof | `eth_getProof` (needs archive for an 8-day lookback) | `linea_getProof` (only ~1 day of finalizations is served) |
| `verifyName` gas | ~0.2M | ~11M (short or unset), ~16M (254-byte name) |

### Verification (on L1)

1. Commit → L2 state root.
   - OP: `isGameClaimValid(game)`, `game.l2SequenceNumber() + window >= anchor`, `rootClaim == keccak(superRoot)` with `(l2ChainId, outputRoot)` in it (or `rootClaim == outputRoot`), `outputRoot == keccak(abi.encode(outputRootProof))`.
   - Linea: `stateRootHashes(l2Block) != 0` and `l2Block + window >= currentL2BlockNumber()`.
2. Account proof: state root → registrar `storageRoot`.
3. Storage proofs: `storageRoot` → the `string` at `keccak(addr . namesSlot)`: the header plus `NameProof.dataSlots` data slots, which must match the header's length. Unset slots are proven absent (Merkle-Patricia exclusion, or two adjacent Linea leaves around the key).

`IL2StorageVerifier.verifyStorageValues()` takes all slots of a name at once so a verifier can share work: Linea uses one **multiproof** with sibling hashes, so the path nodes above the leaves are hashed once. Poseidon2 costs ~50k gas per 32-byte block on L1, which is why Linea's gas is what it is (it was 23–46M with one `linea_getProof`-style path per slot).

## Notes

- **The account proof can't be rebuilt from events.** The indexer captures it when it sees the commit. OP: a finalized game is ~7 days old, past what pruned nodes keep, so bootstrapping needs an archive provider for proofs (proofs prefer Alchemy, logs prefer drpc). Linea: Shomei only serves `linea_getProof` for the last ~10–20 finalizations, so the indexer has to keep up (a missed one is skipped).
- The indexer refuses a commit if the replayed storage root differs from the L2's. That catches any storage write the events don't cover (see [docs/registrar.md](docs/registrar.md)).
- Linea keys leaves by insertion order, so the indexer applies each L2 block's changes together in `hkey` order, as Shomei does.
- `LineaTrie.sol` checks that the `hKey`s of the leaves bounding an exclusion are canonical (every 32-bit limb < p): Poseidon2 reduces inputs mod p, so without it a leaf with an aliased key would hash the same and could "exclude" a key that exists. `test_exclusionAliasedKey` demonstrates it.
- OP Mainnet currently uses **super root** games (type 9). Their `extraData` is the super root preimage.
- The gateway serves the newest valid commit that has been valid for at least `GATEWAY_MARGIN_SEC`, and otherwise the older one, so an L1 node that lags slightly still accepts it.
- **Patches**: OP tries are merkle-builder copy-on-write tries, so the diff walks only the nodes that changed. Linea's trie is mutable, so the indexer logs its rows per L2 block and keeps only the versions retained commits need (`RowLog`). The indexer keeps every pending commit and the 24 most recent valid ones (rebuilt from its change log at startup). If a gateway asks for a patch from a commit the indexer no longer has, it falls back to a snapshot. If the gateway's newest commit becomes invalid (OP blacklisting), it truncates back to its newest valid commit and patches from there.

## Gateway storage (`NodeStore`)

`get(path, version)` (newest row ≤ version) and `floor(prefix, before, version)` (the greatest live path below a key: a Linea exclusion proof needs the key just below the missing one).

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
bun run indexer          # OP Mainnet on :8100 (INDEXER_CHAIN=optimism)
bun run gateway          # :8200, from INDEXER_URL=http://localhost:8100
bun run indexer:linea    # Linea on :8101 (INDEXER_CHAIN=linea)
bun run gateway:linea    # :8201, from http://localhost:8101
```

Indexer API: `GET /status`, `/commits?status=valid&limit=2`, `/commits/:id`, `/snapshot?commit=ID&after=PATH`, `/patch?from=A&to=B`, `/changes?after=&until=`.

Env: `INDEXER_CHAIN`, `INDEXER_PORT`, `INDEXER_DB`, `INDEXER_POLL_MS`, `INDEXER_MAX_ATTEMPTS`, `INDEXER_LOOKBACK_SEC` / `INDEXER_MIN_FINAL_AGE_SEC` (OP), `INDEXER_LOOKBACK_L1_BLOCKS` (Linea), `GATEWAY_CHAIN`, `GATEWAY_PORT`, `GATEWAY_DB`, `GATEWAY_KEEP`, `GATEWAY_MARGIN_SEC`, `GATEWAY_POLL_MS`.

## Test

- `bun run test` runs the property tests, both offline e2es, and the forge tests.
  - [trie.test.ts](test/trie.test.ts): OP patches reproduce merkle-builder tries exactly and row-walked proofs equal `getProof`.
  - [linea.test.ts](test/linea.test.ts): `LineaStorageTrie` matches merkle-builder's `LineaStorage` root by root, patched rows equal a full snapshot, row-built proofs equal `linea_getProof` paths, and mainnet account hashing matches.
  - [store.test.ts](test/store.test.ts): both stores (`get` and `floor`) against an unpruned reference.
  - [offline.test.ts](test/offline.test.ts) (OP) and [offline-linea.test.ts](test/offline-linea.test.ts) (Linea): blocksmith with mock L1 contracts and an in-memory [fake OP rollup](test/fake-rollup.ts) / [fake Linea](test/fake-linea.ts), then the real indexer, gateway, verifier and resolver. They cover name updates, lying proposals and blacklisting (OP), skipped finalizations and the swapped registrar layout with ownership events (Linea), stale commits, and restarts that resume with patches only.
  - forge: [LineaVerifier.t.sol](packages/contracts/test/LineaVerifier.t.sol) runs real mainnet `linea_getProof` output ([fixture](packages/contracts/test/fixtures/linea.json), `bun run fixture:linea`) through the verifier and resolver, plus tampering cases.
- `bun run test:mainnet` needs a running indexer with a valid commit (either chain). It deploys onto an anvil fork of L1 against the real L1 contracts and checks every indexed name.

## License

MIT, except [`packages/contracts/src/lib/linea/Poseidon2.sol`](packages/contracts/src/lib/linea) (Apache-2.0, from Linea). See [`packages/contracts/src/lib/README.md`](packages/contracts/src/lib/README.md).
