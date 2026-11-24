# OP Stack batch inbox (research)

An alternative to dispute games for OP Stack chains: prove an L2 block from the batch data the batcher posts to L1, minutes after the block is made instead of days. Nothing here is deployed. This page records what a verifier would need and what we measured. The hard part is a partial brotli decoder: [brotli.ts](../packages/shared/src/brotli.ts) (TypeScript reference) and [BrotliPrefix.sol](../packages/contracts/src/brotli/BrotliPrefix.sol) (its port). [op-batch.ts](../packages/shared/src/op-batch.ts) reads blob data, frame 0 and the batch prefix; [OPBlob.sol](../packages/contracts/src/op/OPBlob.sol), [OPBatchPrefix.sol](../packages/contracts/src/op/OPBatchPrefix.sol) and [OPBatchInbox.sol](../packages/contracts/src/op/OPBatchInbox.sol) are their ports. Keep each pair in step.

## Trust

The verifier trusts the **sequencer**, through its batcher key (`SystemConfig.batcherHash`). Derivation drops a batch whose parent hash doesn't match the safe chain, but a verifier can't run derivation, so a malicious batcher could post a batch naming a fake parent and the verifier would accept it. That is roughly the trust of a permissioned proposer, with no challenge window. Fast bridges are different: their relayers run derivation themselves, so they trust L1 finality and nothing else.

**Accepted risk: orphaned parents.** An honest batcher can also name a parent that never becomes canonical. It posts batches ahead of the safe head, so a batch's parent may still be unsafe, its own channel not yet complete on L1. If the sequencer then loses those unsafe blocks (a crash, or a failover that hadn't seen them), or the parent's batch lands after the sequencing window (and deposit-only blocks replace it), the chain continues without the parent. The later batch is still on L1, signed by the batcher, and the verifier accepts it until it's `maxL1BlockLag` old. A gateway could then prove storage from a block that was never canonical, such as a name change that was reorged away.

- **Contract:** the verifier doesn't check that the parent became safe. Proving that on-chain would need every frame of the parent's channel (more blobs and KZG proofs) or a later batch built on a descendant (which could be orphaned too), so it's left out.
- **This indexer:** it only commits when the parent is at or below the L2's finalized head and its storage matches the replayed events, so its own commits can't name an orphan. The gap is for proofs built elsewhere.
- **Likelihood:** it needs the sequencer to drop or replace blocks after the batcher has started building on them, which happens only during sequencer outages and failovers.

## What a batch gives

Channel data is `rlp(batch) ...` compressed, after a 1-byte channel version (`0x01` = brotli). The first batch of a channel names its parent block:

| chain | batch type | parent | measured 2026-11-23 |
|---|---|---|---|
| Optimism | span (`0x01`): `rel_timestamp`, `l1_origin_num` (uvarints), `parent_check`, `l1_origin_check` (bytes20) | first 20 bytes of the parent L2 block hash | channel of 5 blobs, one 130 KB frame each |
| Base | singular (`0x00`): `rlp([parent_hash, epoch_num, epoch_hash, timestamp, txs])` | full parent hash | channel continues over several transactions |

Only frame 0 (the first blob of the channel's first transaction) is needed.

A span batch's first block is the one at `l2 genesis time + rel_timestamp` whose parent hash starts with `parent_check`. On a chain with blocks under a second apart (Base since [Denim](base.md#block-time), if it posted span batches), up to five blocks share that timestamp (`blocksAtTimestamp`), so the indexer tries each (`spanBatchParent`). The verifier only compares the L2 header's hash with the batch's parent, so it doesn't depend on the block time.

## Verifier steps

[OPBatchInboxVerifier.sol](../packages/contracts/src/op/OPBatchInboxVerifier.sol) implements `IL2StorageVerifier` with these steps. Its commit proof is `abi.encode(OPBatchInboxCommitProof)` (`encodeOPBatchInboxCommitProof` in [op-batch.ts](../packages/shared/src/op-batch.ts)); the account and storage proofs are the same as `OPFaultVerifier`'s. Parameters: the chain's `SystemConfig` (for `batcherHash()`), its batch inbox, `maxOriginLag` (below the sequencing window, 3600 L1 blocks on Optimism and Base) and `maxL1BlockLag`.

1. L1 block header against `blockhash` / EIP-2935 (8,191 blocks, about 27 hours), at most `maxL1BlockLag` blocks old (`StaleCommit`).
2. The batcher transaction: MPT proof in the block's transaction trie, `to` = the batch inbox, sender recovered from the type-3 signature = `SystemConfig.batcherHash()`.
3. The blob's first field elements against its versioned hash: one KZG point evaluation call per field element (about 54k gas each). Passing the whole blob and evaluating it at a Fiat-Shamir point would need only one call; that's not done.
4. Decompress the start of frame 0 (`BrotliPrefix`) and read the batch prefix (`OPBatchPrefix`).
5. Inclusion block − L1 origin ≤ `maxOriginLag`, set below the sequencing window (`OutsideSequencingWindow`: a late batch is dropped even from an honest batcher).
6. The L2 header: `keccak256(header)` matches the parent hash (or its first 20 bytes); its state root then works as in `OPFaultVerifier`.

## Partial brotli

The prefix can't be read without the meta-block header: literals are Huffman-coded with trees defined up front, and the header is most of what's read. `bun scripts/op-batch-cost.ts` on the fixtures in `packages/contracts/test/fixtures/op-batch/`:

| | Base | Optimism |
|---|---|---|
| compressed bytes read (header) | 1,981 (1,868) | 1,169 (1,077) |
| blob field elements to prove | 64 | 40 |
| prefix codes (complex) | 54 (53) | 39 (39) |
| code-length symbols decoded | 3,628 | 1,819 |
| context map symbols | 308 | 203 |
| literal / distance trees | 22 / 9 | 18 / 7 |
| commands to reach the prefix | 1 | 1 |
| literal trees used | 9 | 2 |

So a Solidity port spends its gas on parsing code lengths. Only the few trees actually used need decode tables. The decoder reads one bit at a time and decodes canonically, as a port would.

The static dictionary is not supported: a reference to it is refused (`BrotliUnsupported`), which costs liveness for that batch, never safety. The dictionary has binary words (`ffffffff00000000`, `0000000100020003`, ...), so binary data can hit it. It didn't in the real frames, whose first bytes are hashes. `test/brotli.test.ts` checks the decoder against node's brotli (google/brotli) on random, structured and text inputs at every quality, and checks that it never accepts a corrupted stream the reference decoder rejects.

## Solidity

`BrotliPrefix.decode(stream, need)` decodes the same prefix as `brotliDecodePrefix`. `test/brotli-sol.test.ts` runs both on the real frames, on compressed inputs at every quality, and on corrupted and truncated streams: outputs match, and failures match too (`BrotliUnsupported` for the dictionary, `BrotliInvalid` otherwise).

| frame (bytes decoded) | gas |
|---|---|
| Optimism (64) | 3.1M |
| Base (112) | 5.5M |

Almost all of it is the header, mostly reading code lengths (`forge test --match-contract BrotliPrefixTest --flamegraph` profiles it). A code's symbol table is only built when the code is first used. With ~2–3M for the blob field elements, a whole proof would be around 10M gas, which fits an `eth_call`. A word-buffered bit reader in assembly is the next step if it needs to be cheaper.

## Blob to batch

`OPBatchInbox.readBatch(versionedHash, commitment, fieldElements, proofs)` does steps 3 and 4:

1. **Prove the field elements.** Element `i` is the blob polynomial at `ω^bitReverse12(i)`, where `ω = 7^((r-1)/4096)`. One point evaluation precompile call per element checks it against the versioned hash; the precompile also checks the commitment.
2. **Decode the blob data** (op-service: 127 bytes per 4 elements, after a version and a 3-byte length), then frame 0 (derivation version 0, frame number 0, channel version 1 = brotli).
3. **Decompress 112 bytes** and read the batch prefix.

The fixtures `packages/contracts/test/fixtures/op-batch/{op,base}-blob.json` hold the first 64 field elements of each real blob, with KZG proofs (`scripts/op-batch-fixture.ts` computes them with `@noble/curves` and the c-kzg trusted setup, and checks the commitment against the transaction's versioned hash). `test/op-batch-sol.test.ts` runs them through the real precompile, rejects tampered proofs, elements and hashes, and matches the TypeScript reference end to end.

| `readBatch` (64 field elements) | gas |
|---|---|
| Optimism | 6.7M (3.4M KZG; 40 elements would do: ~5.4M) |
| Base | 9.0M (3.4M KZG, 5.5M brotli) |

## End to end

`scripts/op-batch-fixture.ts` also stores the L1 header, the batcher transaction's proof in the transactions trie, the batch's parent L2 header and the registrar's account proof. With them:

- `test/op-batch-verifier.test.ts` (offline, L1 block hash set by the test) gets the registrar's real storage root at the parent block on both chains. It refuses an unknown L1 block, another transaction or blob, another batcher or inbox, an origin outside the window, and a header that isn't the parent.
- `bun run test:fork` deploys the verifier unchanged on anvil forks of L1 mainnet after each batch: the L1 block hash from `BLOCKHASH` (100 blocks later) and from EIP-2935 (2,000 later, or as late as exists), and the batcher from the real `SystemConfig`. It needs an archive RPC, and fixtures less than 8,191 blocks old.

| `verifyStorageRoot` | gas |
|---|---|
| Optimism (64 field elements) | 7.6M |
| Base | 10.0M |

## Indexer and gateway

`bun run indexer:base-inbox` (`INDEXER_CHAIN=base-inbox` or `optimism-inbox`) runs [inbox.ts](../packages/registrar-indexer/src/inbox.ts):

- Every tick it looks back from the finalized L1 head (`INDEXER_INBOX_SCAN_BLOCKS`, 64) for the newest batcher blob that starts a channel and whose parent L2 block is final. The newest one's parent often isn't yet (the L2's finalized head follows L1 finality, which moves in 6.4-minute epochs), so it is passed over for an earlier one, and the scan stops at a batch it already committed or skipped. A batch that fails for another reason (event sync, a broken batch) ends the tick; it is retried, then skipped after `INDEXER_MAX_ATTEMPTS`. With no commits yet it looks back further (`INDEXER_INBOX_FIRST_SCAN_BLOCKS`, 300, about an hour), so a first start commits right away. It makes at most one commit per `INDEXER_INBOX_INTERVAL_SEC` (600) of L1 time.
- It builds the whole commit proof. The blob comes from L1's beacon API (`BEACON_URL_1`, default publicnode's). The KZG proofs come from [kzg.ts](../packages/registrar-indexer/src/kzg.ts) (`@noble/curves`, about 0.25s each; the trusted setup is downloaded to `data/kzg/` and checked against its hash). It proves only as many field elements as the batch prefix needs. The transaction's trie proof re-encodes the L1 block's transactions from one `eth_getBlockByNumber` (`rawTransaction`), falling back to `eth_getRawTransactionByHash` per transaction if the root doesn't match.
- The parent L2 block must be at or below the L2's finalized head, and its storage hash must match the replayed events, as for every commit. Commits are valid when found and invalid once their L1 block is more than `INDEXER_INBOX_MAX_L1_BLOCK_LAG` (7200) blocks old, below the verifier's limit (EIP-2935 keeps 8191).
- **Delay** (measured on Base, 2026-11-23): a proof is about 6 minutes behind the L2's finalized head, which trails the tip by about 18 minutes, so about 25 minutes behind the tip. Waiting for L2 finality is the indexer's choice: the verifier alone would accept a block minutes old.
- The gateway serves inbox commits like OP ones (Merkle-Patricia rows): `bun run gateway:base-inbox`.

Checked on mainnet (2026-11-23): with its database seeded from the Base indexer's change log (`base` and `base-inbox` share `data/base.sqlite`), the inbox indexer made its first commit about 20 seconds after starting (L1 block 26,476,802 → L2 block 61,170,215), and `INDEXER_URL=http://localhost:8103 bun run test:mainnet` resolved Base names through CCIP-Read and `OPBatchInboxVerifier` on an L1 fork: 959 of 3,713,621 names verified (250 long).

## Open

- Batcher transactions that put several channels' frames in one blob, or start a blob with the end of a previous channel.

## References

- OP Stack specs: [derivation](https://specs.optimism.io/protocol/derivation.html) (batcher transactions, frames, channels, batches, the sequencing window), [span batches](https://specs.optimism.io/protocol/delta/span-batches.html), [Fjord](https://specs.optimism.io/protocol/fjord/derivation.html) (brotli channels), [configurability](https://specs.optimism.io/protocol/configurability.html) (batch inbox, `batcherHash`)
- [op-service `blob.go`](https://github.com/ethereum-optimism/optimism/blob/develop/op-service/eth/blob.go): how batcher data is packed into blob field elements
- [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844) (blobs, the point evaluation precompile), [EIP-2935](https://eips.ethereum.org/EIPS/eip-2935) (historical block hashes), the [beacon API](https://ethereum.github.io/beacon-APIs/) (blobs)
- [RFC 7932](https://www.rfc-editor.org/rfc/rfc7932) (brotli) and [google/brotli](https://github.com/google/brotli) (the reference decoder the constants come from)
- [c-kzg-4844](https://github.com/ethereum/c-kzg-4844) (trusted setup) and [noble-curves](https://github.com/paulmillr/noble-curves) (BLS12-381)
