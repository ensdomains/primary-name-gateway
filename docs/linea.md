# Linea

| | |
|---|---|
| chain id / coin type | 59144 / `0x8000e708` |
| registrar | `0x0000000000D8e504002cC26E3Ec46D81971C1664` (plain layout, see [registrar.md](registrar.md)) |
| L1 contract | `LineaRollup` `0xd19d4B5d358258f05D7B411E21A1460D11B0876F` |
| commit | a finalization: `DataFinalizedV3(start, end, shnarf, parentStateRootHash, finalStateRootHash)` |
| commit id | the finalized L2 block (`endBlockNumber`) |
| valid when | the L1 block is finalized (the state is ZK proven), every few hours |
| state trie | Shomei sparse Merkle trie (Poseidon2 over KoalaBear), `linea_getProof` |
| verifier | [`LineaVerifier`](../packages/contracts/src/linea/LineaVerifier.sol) + [`LineaTrie`](../packages/contracts/src/linea/LineaTrie.sol) |
| `verifyName` gas | ~11M (short or unset), ~13M (84 bytes), ~16M (254 bytes) |

## The trie

The world state and each contract's storage use the same trie ([Shomei `ZKTrie`](https://github.com/Consensys/shomei/blob/main/trie/src/main/java/net/consensys/shomei/trie/ZKTrie.java)):

- a binary tree of depth 40, with leaves placed in **insertion order** (indices are never reused)
- the leaves form a linked list sorted by `hkey`, between the HEAD (#0) and TAIL (#1) sentinels
- `root = H(pad(nextFreeIndex) . subRoot)`, `leaf = pad(prev) . pad(next) . hkey . hval`
- storage: `hkey = H(pad(slot))`, `hval = H(pad(value))`; accounts: `hkey` of the padded address, `hval` of the 6-word account (`nonce, balance, storageRoot, snarkCodeHash, keccakCodeHash, codeSize`)
- the slots first written in a block are inserted after the block, in `hkey` order

Because leaf indices depend on insertion order, the indexer applies each L2 block's changes together, sorted by `hkey` (`LineaStorageTrie.commit()` in [linea.ts](../packages/shared/src/linea.ts)), as Shomei does. It is checked against merkle-builder's independent `LineaStorage` ([test/linea.test.ts](../test/linea.test.ts)) and against mainnet (see below).

## Commits

The indexer's `LineaCommitSource` ([linea.ts](../packages/registrar-indexer/src/linea.ts)) scans `DataFinalizedV3` up to the L1 `finalized` block. For each finalization it:

1. Fetches the registrar's account proof with `linea_getProof(registrar, [], endBlock)` **right away**. Shomei only serves proofs for roughly the last 10–20 finalizations (about a day), so a finalization the indexer misses is retried and then skipped.
2. Checks the proof against `finalStateRootHash`, and that the leaf is the registrar's (`hkey` and `hval`).
3. Replays the registrar's events up to `endBlock` and checks the storage root against the account.
4. Stores the commit as `valid` immediately: there is no challenge period.

## Verification (on L1)

`LineaVerifier`:

1. `stateRootHashes(l2Block) != 0`: the block was finalized.
2. Freshness: `l2Block + maxBlockLag >= currentL2BlockNumber()`. Finalizations come every few hours (~1,000 L2 blocks), so `maxBlockLag` must exceed that plus the gateway's margin; beyond that it bounds how stale a name can be.
3. Account proof: state root → registrar leaf; the account hashes to the leaf's `hval`; return its `storageRoot`.
4. Storage: for each slot, either its leaf (the value hashes to `hval`) or two adjacent leaves around its `hkey` (`left.next == right`, `right.prev == left`, `left.hkey < hkey < right.hkey`).

Encodings: `commitProof = abi.encode(uint256 l2Block)`, `accountProof` and storage `proof` = `abi.encode(LineaTrie.MultiProof)`.

### Multiproofs, not `linea_getProof` paths

Poseidon2 costs ~50–60k gas per 32-byte block on L1. A `linea_getProof` path carries sibling *preimages* (two extra hashes per level), and a name needs several paths (account + header + data slots, or two neighbours for an unset name): 23–46M gas per lookup. `LineaTrie.MultiProof` carries sibling *hashes* and covers all of a name's leaves at once, so the path nodes they share (most of the 40 levels, since the registrar's tree is small and packed to the left) are hashed once. That brings `verifyName` to ~11M. `IL2StorageVerifier.verifyStorageValues()` takes all of a name's slots in one call for this reason.

### Canonical keys

Poseidon2 reduces input limbs mod p, so a leaf whose `hkey` has a limb increased by p hashes the same as the real leaf. Without a check, such a leaf could bound an exclusion and "prove" that an existing key is absent. `LineaTrie.find` requires every 32-bit limb of the bounding keys to be < p. [`test_exclusionAliasedKey`](../packages/contracts/test/LineaVerifier.t.sol) builds the attack from mainnet data and shows it rejected.

## Trie rows

What the indexer serves and the gateway stores ([linea.ts](../packages/shared/src/linea.ts)):

| path | node |
|---|---|
| `r` | root preimage: `pad(nextFreeIndex) . subRoot` |
| `h{level:02x}{index:x}` | hash of node `index` at `level` 0–39 (level 0 = leaf hash); absent = empty subtree |
| `l{index:x}` | the 192-byte leaf followed by its raw value |
| `k{hkey}` | the leaf index of a key |

The gateway builds multiproofs by copying `h` and `l` rows; it hashes only slot keys and the root row. An exclusion proof needs the greatest key below the missing one, which is `NodeStore.floor("k", ...)`.

The trie is mutable, so the indexer logs its rows per L2 block in a `RowLog` and keeps only the versions its retained commits need; a patch is the rows that changed between two versions.

## Contracts and licensing

`Poseidon2.sol` is vendored from Linea ([lib/README.md](../packages/contracts/src/lib/README.md)), made `internal` and memory-based. Linea's `SparseMerkleProof.sol` is AGPL-3.0, so `LineaTrie.sol` is an independent implementation. Contracts build with solc 0.8.33 and via-IR (Poseidon2 is ~16% cheaper with it).

## Operating

- `INDEXER_LOOKBACK_L1_BLOCKS` (default 3600, ~12h): how far back the first start scans. Older finalizations can't be proven anyway.
- Any provider that supports `linea_getProof` works for proofs; drpc, Alchemy and the public RPC all do.
- `bun run fixture:linea` refreshes the mainnet fixture used by the forge tests.

```sh
bun run indexer:linea   # :8101
bun run gateway:linea   # :8201
```

Checked on mainnet (2026-11-22): replaying all 111 registrar events reproduced `linea_getProof`'s storage root at two finalizations, and `test:mainnet` verified all 99 names on an L1 fork against the real `LineaRollup`.
