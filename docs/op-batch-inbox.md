# OP Stack batch inbox (research)

An alternative to dispute games for OP Stack chains: prove an L2 block from the batch data the batcher posts to L1, minutes after the block is made instead of days. Nothing here is deployed. This page records what a verifier would need and what we measured. The TypeScript reference for the hard part is [brotli.ts](../packages/shared/src/brotli.ts) (partial brotli decoder) and [op-batch.ts](../packages/shared/src/op-batch.ts) (batch prefix).

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

1. L1 block header against `blockhash` / EIP-2935 (8,191 blocks, about 27 hours).
2. The batcher transaction: MPT proof in the block's transaction trie, `to` = the batch inbox, sender recovered from the type-3 signature = `SystemConfig.batcherHash()`.
3. The blob's first field elements against its versioned hash: one KZG point-evaluation call per field element (50k gas), or the whole blob evaluated at a Fiat-Shamir point plus one call.
4. Decompress the start of frame 0 ([brotli.ts](../packages/shared/src/brotli.ts)) and read the batch prefix ([op-batch.ts](../packages/shared/src/op-batch.ts)).
5. Inclusion block − L1 origin < sequencing window (a late batch is dropped even from an honest batcher).
6. The L2 header: `keccak256(header)` matches the parent hash (or its first 20 bytes); its state root then works as in `OPFaultVerifier`.

## Partial brotli

The prefix can't be read without the meta-block header: literals are Huffman-coded with trees defined up front, and the header is most of what's read. `bun scripts/op-batch-cost.ts` on the fixtures in `test/fixtures/op-batch/`:

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

## Open

- Gas: the counts above suggest a few million gas for the header plus ~2–3M for the blob field elements, which fits an `eth_call`. A Solidity port is needed to know.
- Batcher transactions that put several channels' frames in one blob, or start a blob with the end of a previous channel.
