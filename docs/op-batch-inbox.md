# OP Stack batch inbox (research)

An alternative to dispute games for OP Stack chains: prove an L2 block from the batch data the batcher posts to L1, minutes after the block is made instead of days. Nothing here is deployed. This page records what a verifier would need and what we measured. The hard part is a partial brotli decoder: [brotli.ts](../packages/shared/src/brotli.ts) (TypeScript reference) and [BrotliPrefix.sol](../packages/contracts/src/brotli/BrotliPrefix.sol) (its port). [op-batch.ts](../packages/shared/src/op-batch.ts) reads blob data, frame 0 and the batch prefix; [OPBlob.sol](../packages/contracts/src/op/OPBlob.sol), [OPBatchPrefix.sol](../packages/contracts/src/op/OPBatchPrefix.sol) and [OPBatchInbox.sol](../packages/contracts/src/op/OPBatchInbox.sol) are their ports. Keep each pair in step.

## Trust

The verifier trusts the **batcher key** (`SystemConfig.batcherHash`). Derivation drops a batch whose parent hash doesn't match the safe chain, but a verifier can't run derivation, so a malicious batcher could post a batch naming a fake parent and the verifier would accept it. That is roughly the trust of a permissioned proposer, with no challenge window. Fast bridges are different: their relayers run derivation themselves, so they trust L1 finality and nothing else.

## What a batch gives

Channel data is `rlp(batch) ...` compressed, after a 1-byte channel version (`0x01` = brotli). The first batch of a channel names its parent block:

| chain | batch type | parent | measured 2026-11-23 |
|---|---|---|---|
| OP Mainnet | span (`0x01`): `rel_timestamp`, `l1_origin_num` (uvarints), `parent_check`, `l1_origin_check` (bytes20) | first 20 bytes of the parent L2 block hash | channel of 5 blobs, one 130 KB frame each |
| Base | singular (`0x00`): `rlp([parent_hash, epoch_num, epoch_hash, timestamp, txs])` | full parent hash | channel continues over several transactions |

Only frame 0 (the first blob of the channel's first transaction) is needed.

## Verifier steps

[OPBatchInboxVerifier.sol](../packages/contracts/src/op/OPBatchInboxVerifier.sol) implements `IL2StorageVerifier` with these steps. Its commit proof is `abi.encode(OPBatchInboxCommitProof)` (`encodeOPBatchInboxCommitProof` in [op-batch.ts](../packages/shared/src/op-batch.ts)); the account and storage proofs are the same as `OPFaultVerifier`'s. Parameters: the chain's `SystemConfig` (for `batcherHash()`), its batch inbox, `maxOriginLag` (below the sequencing window, 3600 L1 blocks on OP Mainnet and Base) and `maxBlockLag`.

1. L1 block header against `blockhash` / EIP-2935 (8,191 blocks, about 27 hours).
2. The batcher transaction: MPT proof in the block's transaction trie, `to` = the batch inbox, sender recovered from the type-3 signature = `SystemConfig.batcherHash()`.
3. The blob's first field elements against its versioned hash: one KZG point-evaluation call per field element (50k gas), or the whole blob evaluated at a Fiat-Shamir point plus one call.
4. Decompress the start of frame 0 ([brotli.ts](../packages/shared/src/brotli.ts)) and read the batch prefix ([op-batch.ts](../packages/shared/src/op-batch.ts)).
5. Inclusion block − L1 origin < sequencing window (a late batch is dropped even from an honest batcher).
6. The L2 header: `keccak256(header)` matches the parent hash (or its first 20 bytes); its state root then works as in `OPFaultVerifier`.

## Partial brotli

The prefix can't be read without the meta-block header: literals are Huffman-coded with trees defined up front, and the header is most of what's read. `bun scripts/op-batch-cost.ts` on the fixtures in `packages/contracts/test/fixtures/op-batch/`:

| | Base | OP Mainnet |
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
| OP Mainnet (64) | 3.1M |
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
| OP Mainnet | 6.7M (3.4M KZG; 40 elements would do: ~5.4M) |
| Base | 9.0M (3.4M KZG, 5.5M brotli) |

## End to end

`scripts/op-batch-fixture.ts` also stores the L1 header, the batcher transaction's proof in the transactions trie, the batch's parent L2 header and the registrar's account proof. With them:

- `test/op-batch-verifier.test.ts` (offline, L1 block hash set by the test) gets the registrar's real storage root at the parent block on both chains. It refuses an unknown L1 block, another transaction or blob, another batcher or inbox, an origin outside the window, and a header that isn't the parent.
- `bun run test:fork` deploys the verifier unchanged on anvil forks of L1 mainnet after each batch: the L1 block hash from `BLOCKHASH` (100 blocks later) and from EIP-2935 (2,000 later, or as late as exists), and the batcher from the real `SystemConfig`. It needs an archive RPC, and fixtures less than 8,191 blocks old.

| `verifyStorageRoot` | gas |
|---|---|
| OP Mainnet (64 field elements) | 7.6M |
| Base | 10.0M |

## Open

- A commit source for the indexer (each new batcher transaction that starts a channel is a commit) and the gateway's proof assembly (blob field elements and KZG proofs from a beacon API).
- OP Mainnet only needs 40 field elements: size them to the batch.
- The batcher key is trusted. A batch whose channel never completes, or an unsafe-head reorg on the sequencer, would name a parent that never became safe. That's rare with an honest batcher, but `maxBlockLag` limits how long such a commit is accepted.
- Batcher transactions that put several channels' frames in one blob, or start a blob with the end of a previous channel.
