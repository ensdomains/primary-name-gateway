# OP Mainnet

| chain | OP Mainnet |
|---|---|
| chain id / coin type | 10 / `0x8000000a` |
| registrar | `0x0000000000D8e504002cC26E3Ec46D81971C1664` (plain layout, see [registrar.md](registrar.md)) |
| L1 contract | `AnchorStateRegistry` `0x23B2C62946350F4246f9f9D027e071f0264FD113` (v4) |
| commit | a dispute game of the respected type (currently **super root** games, type 9) |
| commit id | game index in the `DisputeGameFactory` |
| valid when | `AnchorStateRegistry.isGameClaimValid(game)`, about 7 days after creation |
| state trie | Merkle-Patricia (keccak), `eth_getProof` |
| verifier | [`OPFaultVerifier`](../packages/contracts/src/op/OPFaultVerifier.sol), one per OP Stack chain |
| `verifyName` gas | ~0.2M |

A faster alternative that trusts the batcher instead of waiting for games is researched in [op-batch-inbox.md](op-batch-inbox.md).

## Commits

The indexer's `OPCommitSource` ([op.ts](../packages/registrar-indexer/src/op.ts)) scans `DisputeGameFactory.gameAtIndex` for games of the respected type. For each game it:

1. Decodes the claim. For super root games, `extraData` is the super root preimage (`keccak(extraData) == rootClaim`): `SuperRootV1 = version(1) . timestamp(8) . [chainId(32) . outputRoot(32)]*`. The L2 block is the one at that timestamp. Output root games carry the L2 block number in `extraData`.
2. Fetches the **block witness** while the L2 still has that state: state root, block hash, the `L2ToL1MessagePasser` storage root, and the registrar's account proof (`eth_getProof`).
3. Checks `outputRoot == keccak(abi.encode(0, stateRoot, messagePasserStorageRoot, blockHash))`. A mismatch is a lying proposal: it's stored as `invalid` and never served.
4. Replays the registrar's events up to that block and checks the storage root against the account proof.
5. Stores the commit as `pending`. Once it's old enough (`INDEXER_MIN_FINAL_AGE_SEC`), it polls `isGameClaimValid` and marks it `valid`. Recent valid games are re-checked, and a game that is blacklisted, retired, or lost (`CHALLENGER_WINS`) becomes `invalid`. The gateway then rewinds past it.

## Early acceptance (`minAgeSec`)

A game takes about 7 days to become a valid claim. `OPFaultVerifier` can optionally accept games sooner: with `minAgeSec > 0` (constructor argument), `isGameAcceptable(game)` is true for a finalized game (`isGameClaimValid`, as with `minAgeSec = 0`), or for a game that is

1. proper and respected according to the `AnchorStateRegistry` (registered, not blacklisted, not retired, not paused, of the respected type when created),
2. not lost (`status != CHALLENGER_WINS`), and
3. either resolved for the defender (waiting for the airgap), or at least `minAgeSec` old and **unchallenged**: `claimDataLen() == 1` for OP's fault dispute games, `counteredByIntermediateRootIndexPlusOne() == 0` for Base's `AggregateVerifier` (type 621). Unknown game types are never accepted early.

**Trust:** this assumes honest challengers respond within `minAgeSec`. A fraudulent proposal that nobody challenges in time is accepted until it is challenged, loses, or is blacklisted; from then on the verifier rejects it, the indexer marks it `invalid`, and gateways rewind to their newest acceptable commit. For calibration, 2 of OP Mainnet's last 200 games (as of 2026-11-22) had been challenged.

The indexer has to apply the same rule as the deployed verifier, or a gateway serves commits the verifier rejects: set `INDEXER_MIN_AGE_SEC` to the verifier's `minAgeSec`. It then polls pending games from that age on, and keeps re-checking the valid games a gateway may hold (the newest `retainValid`).

Freshness doesn't get weaker: `maxSequenceLag` still bounds a game's lag behind the anchor (the newest finalized state), so the oldest acceptable state is the same as without `minAgeSec`. An honest gateway just serves much newer state.

## Reorgs

The indexer's change log is append-only, so it must only ever contain final state:

- Games are discovered, and become `valid`, from **finalized L1** state (`l1BlockTag`, default `finalized`). Invalidation (blacklisting, a lost game) is read from the latest state so it takes effect quickly.
- Anyone can create a game for any L2 block, including one that isn't final. A game whose L2 block (or super root timestamp) is above the **finalized L2** head is deferred, not failed: it's kept in a list and retried every tick, and later games are indexed meanwhile.
- `RegistrarIndexer.addCommit` refuses to sync events past the reader's finalized head, as a backstop.

Waiting for finality costs nothing here: a game takes about 7 days to become valid anyway.

## Verification (on L1)

`OPFaultVerifier.verifyStorageRoot(commitProof, registrar, accountProof)`:

1. `AnchorStateRegistry.isGameClaimValid(game)`: registered, respected type, resolved for the proposer, past the airgap, not blacklisted or retired.
2. Freshness: `game.l2SequenceNumber() + maxSequenceLag >= anchor.l2SequenceNumber`. The unit is seconds for super root games (the sequence number is a timestamp) and blocks for output root games. The anchor only moves when it is updated, so it can trail the newest valid game. `maxSequenceLag` must exceed the time between games plus the gateway's margin; beyond that it bounds how stale a name can be.
3. `rootClaim == keccak(superRoot)` and `superRoot` contains `(l2ChainId, outputRoot)`, or `rootClaim == outputRoot`.
4. `outputRoot == keccak(abi.encode(outputRootProof))`.
5. Account proof: `stateRoot` → registrar `storageRoot` (Merkle-Patricia).

`verifyStorageValues` checks one `eth_getProof` path per slot; unset slots use exclusion proofs.

Encodings: `commitProof = abi.encode(OPFaultCommitProof { game, superRoot, outputRootProof })`, `accountProof = abi.encode(bytes[])`, storage `proof = abi.encode(bytes[][])`.

## Trie rows

Rows are `(absolute nibble path, RLP node)`, merkle-builder's row format ([`EthRowStorage`](https://github.com/ensdomains/merkle-builder#row-storage)): every node, including nodes under 32 bytes that are inlined in their parent. A slot's proof is the rows along its key.

The indexer keeps one row per node. What it serves, and what the gateway stores, are **chunks** ([trie.ts](../packages/shared/src/trie.ts)), so there are far fewer, larger rows:

- A node less than 4 nibbles deep is its own row (the trunk). Every deeper node is in the row of its 4-nibble prefix (a limb): a compact list of `(path suffix, node)` entries.
- `/snapshot` pages are whole chunks, and `/patch` sends every chunk that holds a changed node. Both say `x-row-format: mpt-chunks-4`, and the gateway refuses rows in a layout it doesn't expect.
- A proof reads 4 trunk rows and 1 limb (`chunkReader` reads each chunk once per proof). The rows still hold encoded nodes, so the gateway still hashes nothing.

| Base (2026-11-23) | one row per node | chunks |
|---|---|---|
| rows | 5,076,577 | 69,905 (65,536 limbs, at most 11 KB) |
| a proof reads | 7 rows | 5 rows (0.11 ms) |
| a 100-leaf patch | 517 rows, 183 KB | 299 rows, 814 KB |
| full snapshot | | 102 pages, 393 MB gzipped |

A depth of 3 makes 100 KB rows and 11 MB patches; a depth of 5 still leaves 1.1M rows.

The indexer keeps the trie in its SQLite database as versioned rows ([sql-row-log.ts](../packages/registrar-indexer/src/sql-row-log.ts)), with the change seq as the version:

- Events are applied to an `EthRowStorage`, which reads only the nodes along the touched paths. The changed rows are written every `INDEXER_FLUSH_CHANGES` changes (default 50,000) and at each commit. Rows sit at hashed paths, so each write touches pages all over the table; larger batches share pages and cost memory.
- `trie_head` holds the newest node of every path. `trie_history` holds older nodes for as long as a retained commit (pending, or one of the newest valid) still reads them.
- A snapshot is the chunks at a commit's version. A patch is the chunks holding the nodes written between two versions.
- Memory doesn't grow with the registrar, and a restart resumes from the stored trie instead of replaying every event. On first start with an existing change log, the indexer builds the rows from it.
- A game for an older L2 block than the indexer has synced (out of order) is rebuilt from the newest trie. Every key written since is set back to its value then, from the change log; that gives the storage hash to check. The rows that differ are written into history at the game's version.

## Operating

- **Archive state.** A game becomes valid about 7 days after creation (3.5d clock + 3.5d airgap), which is ~300k L2 blocks, past what pruned nodes keep. In steady state the indexer fetches the witness when a game is created, so recent state is enough. Bootstrapping with a lookback (`INDEXER_LOOKBACK_SEC`, default 8 days) needs an archive provider for proofs: proofs prefer Alchemy and logs prefer drpc.
- `INDEXER_LOOKBACK_SEC` (default 8 days), `INDEXER_MIN_FINAL_AGE_SEC` (default 6 days).
- The gateway serves the newest valid commit that has been valid for at least `GATEWAY_MARGIN_SEC`, so an L1 node that lags slightly still accepts it.

```sh
bun run indexer   # :8100
bun run gateway   # :8200
```

## References

- OP Stack specs: [fault dispute game](https://specs.optimism.io/fault-proof/stage-one/fault-dispute-game.html), [`AnchorStateRegistry`](https://specs.optimism.io/fault-proof/stage-one/anchor-state-registry.html), [output roots](https://specs.optimism.io/protocol/proposals.html)
- [Contract addresses](https://docs.optimism.io/superchain/addresses)
