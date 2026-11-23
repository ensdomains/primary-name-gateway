# Base

Base is an OP Stack chain, so it uses the OP path ([optimism.md](optimism.md)) end to end: `OPCommitSource`, Merkle-Patricia rows, and the same `OPFaultVerifier` contract deployed for Base. This page covers what differs.

| chain | Base |
|---|---|
| chain id / coin type | 8453 / `0x80002105` |
| registrar | `0x0000000000D8e504002cC26E3Ec46D81971C1664`, **Ownable** layout: names at slot 0, owner at slot 1 (see [registrar.md](registrar.md)) |
| L1 contracts | `AnchorStateRegistry` `0x909f6cf47ed12f010A796527f562bFc26C7F4E72` (v3.7.0), `DisputeGameFactory` `0x43edB88C4B80fDD2AdFF2412A7BebF9dF42cB40e`, `OptimismPortal` `0x49048044D57e1C92A77f79988d21Fa8fAF74E97e` |
| commit | an **output root** game of type **621** |
| commit id | game index |
| valid when | `isGameClaimValid(game)`, about 5 days after creation |
| verifier | [`OPFaultVerifier`](../packages/contracts/src/op/OPFaultVerifier.sol)`(AnchorStateRegistry, 8453, maxSequenceLag)` |

## Game type 621: `AggregateVerifier`

Base's respected game type is not one of OP's (0/1 output root, 9 super root). Type 621 is Base's [`AggregateVerifier`](https://github.com/base/contracts/blob/main/src/L1/proofs/AggregateVerifier.sol): a multiproof game that resolves with TEE and ZK proofs, with a 1-day fast and a 5-day slow finalization delay. In practice games become valid about 120 hours after creation.

What this repo relies on is the standard `IDisputeGame` surface, which it keeps:

- `rootClaim` is a standard (version 0) output root. Checked on mainnet: the latest game's root matched the output root recomputed from L2.
- `extraData` is `l2BlockNumber (32) . parentGame (20) . intermediate roots (32 each)`. `decodeGameClaim` reads the first word as the L2 block, as for any output root game.
- `l2SequenceNumber()` is the L2 block number, so `maxSequenceLag` is in **blocks** (2s each), not seconds as on OP Mainnet's super root games.
- `status()` uses the standard `GameStatus` (`CHALLENGER_WINS` = 1), and validity, blacklisting and retirement come from the `AnchorStateRegistry`.

Games are created about every 20 minutes.

## Early acceptance

`OPFaultVerifier`'s `minAgeSec` option ([optimism.md](optimism.md#early-acceptance-minagesec)) works for type 621: a game counts as unchallenged while `counteredByIntermediateRootIndexPlusOne() == 0`. Every game starts with a TEE proof; a challenge is a ZK proof against it. None of Base's last 200 games (as of 2026-11-22) had been challenged.

## Registrar

Base's registrar is `L2ReverseRegistrarWithMigration` (Ownable), so its storage includes the owner at slot 1 and the indexer replays `OwnershipTransferred` as well as `NameForAddrChanged`. The migration's `batchSetName` writes names in bulk, and it also emits `NameForAddrChanged`, so the storage is still a fold over events.

Base is big enough that two storage keys share a 9-nibble prefix, so some leaves sit deep enough to encode in under 32 bytes. Those leaves are embedded in their parent instead of referenced by hash. merkle-builder 0.2.0 encoded those references wrong, so every Base game failed the storage hash check (replaying 3.77M events gave `0xeb7cab…` where Base had `0xf48b24cf…` at L2 block 58,458,360). 0.3.0 encodes them correctly; `test/inline-node.test.ts` checks embedded nodes end to end.

## Operating

- The indexer's defaults follow `gameFinalitySec` (5 days): it looks back 6 days on first start and starts polling validity for games older than 4 days.
- The 6-day lookback needs archive `eth_getProof` on Base (Alchemy serves it; drpc doesn't that far back).
- The trie (about 5M rows, 730 MB) lives in the indexer's database. On first start the indexer builds it from the change log: replaying 3.77M events took 3.5 minutes with a 783 MB peak RSS on an M-series Mac (2026-11-22, defaults). The in-memory trie it replaced needed about 2.5 GB. Larger `INDEXER_FLUSH_CHANGES` builds faster but uses more memory (100,000: 2.7 minutes, 2 GB; 10,000: 6.4 minutes, 340 MB).
- Base's L2 finalized head trails its tip by about 3 hours. Games for blocks above it are deferred until it catches up ([optimism.md#reorgs](optimism.md#reorgs)).
- `mainnet.base.org` rate limits `eth_getLogs`, so there is no public RPC fallback: set `DRPC_KEY` or `INFURA_KEY` for logs.
- The registrar's history has very dense stretches (the migration's `batchSetName`: over 12,000 events in ~120 blocks), past what providers return per request (drpc: 20,000 results). The reader shrinks its range down to a single block when needed, and grows it back once events are sparse ([rpc.md](rpc.md)).

```sh
bun run indexer:base   # :8102
bun run gateway:base   # :8202
```

## Checked on mainnet

2026-11-23:

- **Commits.** The indexer replayed 3,775,126 registrar events. Every game's storage hash matched Base's `eth_getProof`, including 16 games for blocks older than the synced head, which were rebuilt from the newest trie in under a second each. It ended with 84 valid commits and 359 pending, and none skipped.
- **Names.** `test:mainnet` resolved names through `L2ReverseResolver` on an L1 fork at game 26698 (L2 block 58,956,360, 3,711,020 addresses). It verified 959 names against the registrar, 250 of them long (32 bytes or more).
- **Memory.** The indexer ran at 63 MB RSS in steady state.
