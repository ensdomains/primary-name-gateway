# Base

Base is an OP Stack chain, so it uses the OP path ([optimism.md](optimism.md)) end to end: `OPCommitSource`, Merkle-Patricia rows served as [chunks](optimism.md#chunks), and the same `OPFaultVerifier` contract deployed for Base. This page covers what differs. The batch inbox ([op-batch-inbox.md](op-batch-inbox.md)) also runs on Base (`base-inbox`).

| chain | Base |
|---|---|
| chain id / coin type | 8453 / `0x80002105` |
| registrar | `0x0000000000D8e504002cC26E3Ec46D81971C1664`, **Ownable** layout: names at slot 0, owner at slot 1 (see [registrar.md](registrar.md)) |
| L1 contracts | `AnchorStateRegistry` `0x909f6cf47ed12f010A796527f562bFc26C7F4E72` (v3.7.0), `DisputeGameFactory` `0x43edB88C4B80fDD2AdFF2412A7BebF9dF42cB40e`, `OptimismPortal` `0x49048044D57e1C92A77f79988d21Fa8fAF74E97e` |
| commit | an **output root** game of type **621** |
| commit id | game index |
| valid when | `isGameClaimValid(game)`, about 5 days after creation |
| verifier | [`OPFaultVerifier`](../packages/contracts/src/op/OPFaultVerifier.sol)`(AnchorStateRegistry, 8453, maxL2SequenceLag, minAgeSec)` |

## Game type 621: `AggregateVerifier`

Base's respected game type is not one of OP's (0/1 output root, 9 super root). Type 621 is Base's [`AggregateVerifier`](https://github.com/base/contracts/blob/main/src/L1/proofs/AggregateVerifier.sol): a multiproof game that resolves with TEE and ZK proofs, with a 1-day fast and a 5-day slow finalization delay. In practice games become valid about 120 hours after creation.

How the two delays work, and what mainnet does (checked 2026-11-24):

- A game is created with one proof (in practice the TEE one), which sets its resolution to `SLOW_FINALIZATION_DELAY` (5 days). Anyone can add the other proof kind (`verifyProposalProof`); with two proofs the resolution moves to `FAST_FINALIZATION_DELAY` (1 day). A ZK proof that disagrees is a `challenge()` instead. `PROOF_THRESHOLD` is 1.
- A game resolves only after its parent game has, so the 1-day path only helps if every game back to the anchor has both proofs. Adding a ZK proof to a single game (it's permissionless) doesn't make that game final sooner.
- On mainnet no game uses it: the last 400 games (about 5.5 days) all had a TEE prover and no ZK prover, none was challenged, and each resolves exactly 5.0 days after creation. L1 had no ZK `Proved` event and no `Challenged` event from any contract over the ~187 days since Azul (L1 blocks 25,137,865 to 26,487,865), while the same query finds about 73 TEE proofs a day.

What this repo relies on is the standard `IDisputeGame` surface, which it keeps:

- `rootClaim` is a standard (version 0) output root. Checked on mainnet: the latest game's root matched the output root recomputed from L2.
- `extraData` is `l2BlockNumber (32) . parentGame (20) . intermediate roots (32 each)`. `decodeGameClaim` reads the first word as the L2 block, as for any output root game.
- `l2SequenceNumber()` is the L2 block number, so `maxL2SequenceLag` is in **blocks**, not seconds as on Optimism's super root games. Since Denim a block is 0.2 s ([below](#block-time)): 86,400 blocks is 4.8 hours, not 2 days.
- `status()` uses the standard `GameStatus` (`CHALLENGER_WINS` = 1), and validity, blacklisting and retirement come from the `AnchorStateRegistry`.

Games are created about every 20 minutes (6,000 blocks).

## Block time

Base's [Denim](https://docs.base.org/upgrades/denim/200ms-blocks) upgrade cut the block time from 2 s to 200 ms at L2 block **53,556,127** (2026-11-05 18:00:01 UTC, the first header with `timestampMs`). Header timestamps stay in whole seconds, so five blocks share each one, and the millisecond part follows from the block number. `l2Blocks` in [chains.ts](../packages/shared/src/chains.ts) records both segments; `blocksAtTimestamp` gives the blocks of a timestamp. Checked against Base's headers at 21 blocks from genesis to the head.

What depends on it:

- **Batch inbox:** a span batch names its first block by timestamp, which now matches up to five blocks. `parent_check` picks one (`spanBatchParent` in [inbox.ts](../packages/registrar-indexer/src/inbox.ts)). Base posts singular batches, which name the parent by hash.
- **Super root games** name a timestamp; `blockAtTimestamp` refuses one that matches several blocks. Base's games are output root games, which name a block.
- **`maxL2SequenceLag`** counts blocks (above).

## Early acceptance

`OPFaultVerifier`'s `minAgeSec` option ([optimism.md](optimism.md#early-acceptance-minagesec)) works for type 621: a game counts as unchallenged while `counteredByIntermediateRootIndexPlusOne() == 0`. Every game starts with a TEE proof; a challenge is a ZK proof against it. None of Base's last 200 games (as of 2026-11-22) had been challenged.

## Registrar

Base's registrar is `L2ReverseRegistrarWithMigration` (Ownable), so its storage includes the owner at slot 1 and the indexer replays `OwnershipTransferred` as well as `NameForAddrChanged`. The migration's `batchSetName` writes names in bulk, and it also emits `NameForAddrChanged`, so the storage is still a fold over events.

Base is big enough that two storage keys share a 9-nibble prefix, so some leaves sit deep enough to encode in under 32 bytes. Those leaves are embedded in their parent instead of referenced by hash. merkle-builder 0.2.0 encoded those references wrong, so every Base game failed the storage hash check (replaying 3.77M events gave `0xeb7cab…` where Base had `0xf48b24cf…` at L2 block 58,458,360). 0.3.0 encodes them correctly; `test/inline-node.test.ts` checks embedded nodes end to end.

## Operating

- The indexer's defaults follow `gameFinalitySec` (5 days): it looks back 6 days on first start and starts polling validity for games older than 4 days.
- The 6-day lookback needs archive `eth_getProof` on Base (Alchemy serves it; drpc doesn't that far back).
- The trie (about 5M rows, 730 MB) lives in the indexer's database. On first start the indexer builds it from the change log: replaying 3.77M events took 3.5 minutes with a 783 MB peak RSS on an M-series Mac (2026-11-22, defaults). The in-memory trie it replaced needed about 2.5 GB. Larger `INDEXER_FLUSH_CHANGES` builds faster but uses more memory (100,000: 2.7 minutes, 2 GB; 10,000: 6.4 minutes, 340 MB).
- Base's L2 finalized head trails its tip by about 20 minutes (18 measured, 2026-11-23). Games for blocks above it are deferred until it catches up ([optimism.md#reorgs](optimism.md#reorgs)).
- `mainnet.base.org` rate limits `eth_getLogs`, so it is never used as a fallback (only for `"public"`): set a paid `DRPC_KEY` or an `INFURA_KEY` for logs (drpc's free plan allows only 100-block ranges).
- The registrar's history has very dense stretches (the migration's `batchSetName`: over 12,000 events in ~120 blocks), past what providers return per request (drpc: 20,000 results). The reader sizes each range for about 5,000 logs from the previous range's density (at most doubling), cuts it by 8 when a provider refuses it, down to a single block if needed, and starts each run at 5,000 blocks ([rpc.md](rpc.md)). On drpc a refused range takes 5–30 s, so avoiding refusals matters more than range size: a catch-up through Base's dense stretch ran at about 10,000 blocks/s.

```sh
bun run indexer:base   # :8102
bun run gateway:base   # :8202
```

## Checked on mainnet

2026-11-23:

- **Commits.** The indexer replayed 3,775,126 registrar events. Every game's storage hash matched Base's `eth_getProof`, including 16 games for blocks older than the synced head, which were rebuilt from the newest trie in under a second each. It ended with 84 valid commits and 359 pending, and none skipped.
- **Names.** `test:mainnet` resolved names through `L2ReverseResolver` on an L1 fork at game 26698 (L2 block 58,956,360, 3,711,020 addresses). It verified 959 names against the registrar, 250 of them long (32 bytes or more).
- **Memory.** The indexer ran at 63 MB RSS in steady state.

## References

- [Base contract addresses](https://docs.base.org/base-chain/network-information/base-contracts)
- [`AggregateVerifier`](https://github.com/base/contracts/blob/main/src/L1/proofs/AggregateVerifier.sol) (game type 621)
