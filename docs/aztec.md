# Aztec (researched, not built)

Research done **2026-11-27** against Aztec's mainnet ("Alpha", release v6 "Tierra", node 6.0.0): its L1 contracts, a public node, and the v6.0.0 sources. The proof path below was recomputed from real mainnet data. Nothing here is implemented.

**Why it isn't built:** Aztec addresses are 32-byte field elements, not 20-byte EVM addresses. ENSIP-19's EVM coin types (`0x80000000 | chainId`) and `L2ReverseResolver` (`primarySlot(address, namesSlot)`) assume EVM addresses. Aztec would need a non-EVM coin type and a 32-byte reverse label, which is an ENS-side decision. There's also no registrar on Aztec yet.

| | |
|---|---|
| L1 `Rollup` | `0xE37A2663Cc9c119BA41572C40fAb0bbb23a5402f` (`Registry` `0x35b22e09Ee0390539439E24f06Da43D83f90e298`, rollup version 2070860440) |
| commitment | `archiveAt(checkpoint)`: the archive tree root after a checkpoint, kept for every checkpoint; trusted up to `getProvenCheckpointNumber()` |
| trust | validity proofs (epoch proofs checked by the `HonkVerifier`); 21 prover ids in the 3,000 L1 blocks checked |
| proofs | one epoch (32 checkpoints) about every 192 L1 blocks (38 minutes) |
| delay | the proven tip trailed the head by 22 minutes when sampled; with epochs that's about 20–60 minutes, plus L1 finality: roughly 35–75 minutes |
| state | public storage in the public data tree: an indexed Merkle tree, Poseidon2 over BN254 |
| node | JSON-RPC, `aztec_` methods; public endpoint `https://aztec-mainnet.drpc.org` |

## The proof path

From an L1 archive root down to one public storage slot. Checked on 2026-11-27 with checkpoint 37,356 (proven), whose only block is 67,388:

1. **Archive root on L1.** `Rollup.archiveAt(37356)` = `0x0a90…4eb9`, the `archive.root` of block 67,388 as the node reports it. Any block of a proven checkpoint can be proven against that checkpoint's archive.
2. **Block hash in the archive.** The archive tree has height 30, and its leaves are block hashes at index = block number. A node is `poseidon2([DOM_SEP__MERKLE_HASH, left, right])`. The node gives the path with `aztec_getBlockHashMembershipWitnessAtArchive({archive}, blockHash)`: a 32-byte leaf index, then 30 siblings, no length prefix.
3. **The header.** The block hash is `poseidon2([DOM_SEP__BLOCK_HEADER_HASH, …23 fields])`, in `abis/block_header.nr` order:
   - `lastArchive` root and next index;
   - the l1ToL2Message, noteHash, nullifier and publicData trees' roots and next indices;
   - `spongeBlobHash`, `txEffectsTreeRoot`;
   - the global variables: chainId, version, blockNumber, slotNumber, timestamp, coinbase, feeRecipient, feePerDaGas, feePerL2Gas;
   - `totalFees`, `totalManaUsed`.

   `aztec_getBlock` returns them as JSON.
4. **The slot in the public data tree.** The leaf slot is `poseidon2([DOM_SEP__PUBLIC_LEAF_SLOT, contract, slot])`, where `slot` is the Noir storage slot. The tree has height 40. A leaf is `poseidon2([slot, value, nextKey, nextIndex])` (no separator), and a node is `poseidon2([DOM_SEP__PUBLIC_DATA_MERKLE, left, right])`. `aztec_getPublicDataWitness(block, leafSlot)` returns the leaf, or for an unset slot its low leaf (non-membership: `leaf.slot < slot < nextKey`, value 0), plus a 4-byte count and 40 siblings. It must be checked against `header.state.partial.publicDataTree.root`.

**Poseidon2** is barretenberg's (`barretenberg/cpp/src/barretenberg/crypto/poseidon2/`): BN254, width 4, x⁵ s-box, 8 full and 56 partial rounds. The sponge has rate 3 and capacity 1, with IV = `inputs.length << 64` in the capacity element, zero padding, and the output is `state[0]` after one more permutation. The domain separators come from `constants.nr` at v6.0.0:

| separator | value |
|---|---|
| `DOM_SEP__BLOCK_HEADER_HASH` | 4195546849 |
| `DOM_SEP__MERKLE_HASH` | 2982624097 |
| `DOM_SEP__PUBLIC_DATA_MERKLE` | 3756303423 |
| `DOM_SEP__PUBLIC_LEAF_SLOT` | 1247650290 |

What matched, on mainnet data and the sources' test vectors:
- the permutation vector, and the leaf-slot, public-data-leaf and empty-header vectors;
- block 67,388's hash recomputed from its header (`0x0ee0…4745`);
- the archive path reproducing `archiveAt(37356)`;
- a non-membership witness for slot `0x1234` reproducing the header's public data root (`0x2229…70af`).

**Cost.** One slot takes 81 Poseidon2 permutations: 8 for the header, 30 for the archive path, 42 for the public data leaf and path, and 1 for the leaf slot. Each further slot costs about 43 more. merkle-builder's and `LineaTrie`'s Poseidon2 is a different instance (KoalaBear, width 16, x³), so a verifier would need a BN254 one. Gas per permutation wasn't measured. A width-4 BN254 permutation is about 64 rounds of `mulmod` work, so on the order of 15–20k gas: roughly 1.2–1.6M for a one-slot name.

## A registrar on Aztec

- **Public storage.** A primary name is public anyway, so a registrar would keep `Map<AztecAddress, …>` in public state, set from a public function (which reveals the caller).
- **Name layout.** Aztec storage holds field elements, so a name spans one slot per 31 bytes, each a separate 43-permutation proof. Cheaper: store a Poseidon2 hash of the name in one slot, and let the gateway supply the name for the verifier to hash.
- **Indexing.** The gateway wouldn't need its own trie: the node serves witnesses for any block. An indexer would only pick a proven checkpoint and confirm its archive root on finalized L1.
- **Another model: push.** The registrar could send each change as an L2→L1 message, which an L1 contract consumes from the `Outbox` once the epoch is proven. Names would then live on L1 with no proofs at read time, at the cost of an L1 transaction per change.
- **Upgrades.** Governance can register a new rollup version in the `Registry`, so a verifier bound to one `Rollup` address would have to follow upgrades.

## To re-check

- [ ] Does ENS define a coin type and reverse-name format for Aztec (32-byte addresses)?
- [ ] Is there an Aztec registrar, and what's its storage layout (one slot per 31 bytes, or a hash)?
- [ ] The current rollup address in the `Registry`, the domain separators and the header layout, if the release has changed since v6.0.0.
- [ ] Gas of a Solidity Poseidon2 (BN254, width 4) permutation.

## Sources (read 2026-11-27)

- Aztec: [networks (addresses, RPC)](https://docs.aztec.network/networks) (from [`docs/docs/networks.md`](https://github.com/AztecProtocol/aztec-packages/blob/master/docs/docs/networks.md)), [node API reference v6.0.0](https://github.com/AztecProtocol/aztec-packages/blob/master/docs/network_versioned_docs/version-v6.0.0/operators/reference/node-api-reference.md), [public data tree](https://docs.aztec.network/protocol-specs/state/public-data-tree), [indexed Merkle tree](https://docs.aztec.network/aztec/concepts/storage/trees/indexed_merkle_tree), [Rollup.sol](https://github.com/AztecProtocol/aztec-packages/blob/master/l1-contracts/src/core/Rollup.sol)
- Finality: [block times and reorgs (forum)](https://forum.aztec.network/t/how-are-apps-and-infras-affected-by-aztec-block-times-and-how-to-handle-re-orgs/7693), [block production RFC (forum)](https://forum.aztec.network/t/request-for-comments-aztecs-block-production-system/6155)
- ENS: [ENSIP-19](https://docs.ens.domains/ensip/19), [ENSIP-11](https://docs.ens.domains/ensip/11), [ENSIP-9](https://docs.ens.domains/ensip/9)
