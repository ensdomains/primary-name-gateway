# primary-name-gateway

Trustless L1 resolution of ENS primary names stored in an L2's `L2ReverseRegistrar`, without an archive node at request time.

Starts with **OP Mainnet** (`0x0000000000D8e504002cC26E3Ec46D81971C1664`, coin type `0x8000000a`).

```
 L1 ─ dispute games ─┐                                  ┌─ resolve(name, name()) ── L2ReverseResolver ── OPFaultVerifier ── L1 AnchorStateRegistry
                     ▼                                  │         │ OffchainLookup                  ▲ verify proofs
 L2 ─ NameForAddrChanged ─► registrar-indexer ── snapshot / patch ──► registrar-gateway (ezccip) ◄─────┘
     + eth_getProof(registrar)   (sqlite + tries per commit)  trie rows   (NodeStore: versioned trie rows, latest 2 valid commits)
```

## Packages

| package | what |
|---|---|
| [`registrar-indexer`](packages/registrar-indexer) | Watches the L1 `DisputeGameFactory` for games of the respected type. For each game it decodes the claim (super root or output root), finds the L2 block, fetches the **block witness** (state root, block hash, message passer root, registrar account proof) while that state is still available, replays `NameForAddrChanged` into a [merkle-builder](https://github.com/ensdomains/merkle-builder) trie up to that block, and checks the rebuilt `storageHash` against the account proof. Games become `valid` once `AnchorStateRegistry.isGameClaimValid(game)`. Serves an HTTP API. |
| [`registrar-gateway`](packages/registrar-gateway) | Holds the latest valid commits (keeps 2) as **versioned trie rows** `(nibble path, version = L2 block) → RLP node` in a `NodeStore`. It bootstraps from a paged `/snapshot`, then only downloads `/patch` rows (the nodes that changed between commits, already encoded with their child hashes by the indexer). Proofs are produced by walking rows and copying encodings, so the gateway has **no trie in memory and computes no hashes** (one keccak per commit to check the root). State lives in the store, so a restart resumes with patches. The library is runtime-agnostic (`src/index.ts`); `src/main.ts` is the bun server using `bun:sqlite`. Answers CCIP-Read `proveName(address)` with an ABI-encoded `NameProof` via [ezccip](https://github.com/namestonehq/ezccip.js). |
| [`contracts`](packages/contracts) | `L2ReverseResolver`: an ENSIP-10 `IExtendedResolver` for `{addr}.{coinType}.reverse` that supports `name()`, does CCIP-Read to the gateway and verifies the response. `OPFaultVerifier`: an `IL2StorageVerifier` for OP Stack fault-proof chains (one deployment per chain), which other OP Stack resolvers can share. |
| [`shared`](packages/shared) | Chain config, registrar layout, OP game decoding, and the indexer ↔ gateway JSON types. |

## Verification (on L1)

1. `AnchorStateRegistry.isGameClaimValid(game)`: registered, respected type, resolved for the proposer, past the airgap, not blacklisted or retired.
2. Freshness: `game.l2SequenceNumber() + window >= anchor.l2SequenceNumber`.
3. `rootClaim == keccak(superRoot)` and `superRoot` contains `(l2ChainId, outputRoot)`, or `rootClaim == outputRoot` for output-root games.
4. `outputRoot == keccak(abi.encode(outputRootProof))`.
5. Account proof: `stateRoot` → registrar `storageRoot`.
6. Storage proofs: `storageRoot` → the Solidity `string` at `keccak(addr . 0)`, i.e. the header slot plus `ceil(len/32)` data slots. Unset slots use exclusion proofs.

## Notes

- **The account proof can't be rebuilt from events.** It has to be fetched near proposal time. A finalized OP game is about 7 days old (about 300k L2 blocks), which is past what pruned nodes keep. In steady state the indexer only needs recent state. Bootstrapping with a lookback (default 8 days) needs an archive provider for proofs, so proofs prefer Alchemy and logs prefer drpc.
- OP Mainnet currently uses **super root** games (type 9). Their `extraData` is the super root preimage.
- The indexer refuses to store a commit if the replayed `storageHash` differs from the L2's. That catches any storage write the events don't cover.
- The gateway serves the newest valid commit that has been valid for at least `GATEWAY_MARGIN_SEC`, and otherwise the older one, so an L1 node that lags slightly still accepts it.
- **Patches** come from merkle-builder's copy-on-write tries: an unchanged subtree is the same object at the same path in both commits, so the diff is a walk over the nodes that changed, including leaves that moved when a neighbour was inserted or deleted. The indexer keeps the trie of every pending commit and the 24 most recent valid ones (rebuilt from its change log at startup). If a gateway asks for a patch from a commit the indexer no longer has, it falls back to a snapshot. If the gateway's newest commit becomes invalid (blacklisted), it truncates back to its newest valid commit and patches from there.

## Gateway storage (`NodeStore`)

| store | use |
|---|---|
| `MemoryNodeStore` | tests, ephemeral |
| `SqlNodeStore` + `bunSqliteAdapter(db)` | the bun server (`GATEWAY_DB`, default `data/gateway-optimism.sqlite`) |
| `SqlNodeStore` + a Durable Object adapter | `{ exec: (q, ...p) => ctx.storage.sql.exec(q, ...p).toArray(), transaction: (fn) => ctx.storage.transactionSync(fn) }`, with `sync()` driven by an alarm and requests handled with `ezccip.handleRead(sender, data, { protocol: "raw" })`. A snapshot load saves its cursor after each page, so it can continue across alarms. |

## Setup

```sh
bun i
cd packages/contracts && forge build
```

`.env` (see [`.env.sample`](.env.sample)): `DRPC_KEY` and/or `ALCHEMY_KEY`, or `RPC_URL_<chainId>` / `PROOF_RPC_URL_<chainId>`.

## Run

```sh
bun run indexer   # :8100  GET /status, /commits?status=valid&limit=2, /commits/:gameIndex,
                  #        /snapshot?game=G&after=PATH, /patch?from=A&to=B, /changes?after=&until=
bun run gateway   # :8200  CCIP-Read endpoint (INDEXER_URL=http://localhost:8100)
```

Env: `INDEXER_PORT`, `INDEXER_DB`, `INDEXER_POLL_MS`, `INDEXER_LOOKBACK_SEC`, `INDEXER_MIN_FINAL_AGE_SEC`, `GATEWAY_PORT`, `GATEWAY_DB`, `GATEWAY_KEEP`, `GATEWAY_MARGIN_SEC`, `GATEWAY_POLL_MS`.

## Test

- `bun run test` runs the trie row and store property tests, the offline e2e, and the forge unit tests. [trie.test.ts](test/trie.test.ts) checks that patches reproduce merkle-builder tries exactly and that row-walked proofs equal `getProof`. [store.test.ts](test/store.test.ts) checks both stores against an unpruned reference. The [offline e2e](test/offline.test.ts) uses blocksmith with mock OP L1 contracts and an in-memory [fake rollup](test/fake-rollup.ts), then runs the real indexer, gateway, verifier and resolver. It covers name updates, a lying proposal, stale games, blacklisting, and a gateway restart that resumes from SQLite with patches only.
- `bun run test:mainnet` needs `bun run indexer` running with at least one valid commit. It deploys onto an anvil fork of L1 against the real OP AnchorStateRegistry and checks every indexed name.
