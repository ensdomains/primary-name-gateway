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

## Commits

The indexer's `OPCommitSource` ([op.ts](../packages/registrar-indexer/src/op.ts)) scans `DisputeGameFactory.gameAtIndex` for games of the respected type. For each game it:

1. Decodes the claim. For super root games, `extraData` is the super root preimage (`keccak(extraData) == rootClaim`): `SuperRootV1 = version(1) . timestamp(8) . [chainId(32) . outputRoot(32)]*`. The L2 block is the one at that timestamp. Output root games carry the L2 block number in `extraData`.
2. Fetches the **block witness** while the L2 still has that state: state root, block hash, the `L2ToL1MessagePasser` storage root, and the registrar's account proof (`eth_getProof`).
3. Checks `outputRoot == keccak(abi.encode(0, stateRoot, messagePasserStorageRoot, blockHash))`. A mismatch is a lying proposal: it's stored as `invalid` and never served.
4. Replays the registrar's events up to that block and checks the storage root against the account proof.
5. Stores the commit as `pending`. Once it's old enough (`INDEXER_MIN_FINAL_AGE_SEC`), it polls `isGameClaimValid` and marks it `valid`. Recent valid games are re-checked, and a game that is blacklisted, retired, or lost (`CHALLENGER_WINS`) becomes `invalid`. The gateway then rewinds past it.

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

Rows are `(absolute nibble path, RLP node)` ([trie.ts](../packages/shared/src/trie.ts)). The indexer's tries are merkle-builder copy-on-write tries, so a commit is just its root node, and the patch between two commits walks only the nodes that differ (including leaves that moved when a neighbour was inserted or deleted). The gateway proves a slot by walking rows along its key.

## Operating

- **Archive state.** A game becomes valid about 7 days after creation (3.5d clock + 3.5d airgap), which is ~300k L2 blocks, past what pruned nodes keep. In steady state the indexer fetches the witness when a game is created, so recent state is enough. Bootstrapping with a lookback (`INDEXER_LOOKBACK_SEC`, default 8 days) needs an archive provider for proofs: proofs prefer Alchemy and logs prefer drpc.
- `INDEXER_LOOKBACK_SEC` (default 8 days), `INDEXER_MIN_FINAL_AGE_SEC` (default 6 days).
- The gateway serves the newest valid commit that has been valid for at least `GATEWAY_MARGIN_SEC`, so an L1 node that lags slightly still accepts it.

```sh
bun run indexer   # :8100
bun run gateway   # :8200
```
