# Celo

Celo has been an OP Stack chain since L2 block 31,056,500 (2025-03-26; before it, Celo was its own L1), so it uses the OP path ([optimism.md](optimism.md)) end to end: `OPCommitSource`, Merkle-Patricia rows served as [chunks](optimism.md#chunks), and `OPFaultVerifier` deployed for Celo. This page covers what differs. Checked on chain 2026-11-25.

| chain | Celo |
|---|---|
| chain id / coin type | 42220 / `0x8000a4ec` |
| registrar | no ENS registrar yet: a mock at `0x07e0B99DDFcc4F0750ab5FB46084cAd9235a918b`, created at L2 block 83,729,711, **plain** layout (names at slot 0, see [below](#registrar)) |
| L1 contracts | `AnchorStateRegistry` `0x8fE58d2168b5412Cf1Bd212cE6137f8b7300222d` (v3.5.0), `DisputeGameFactory` `0xFbAC162162f4009Bb007C6DeBC36B1dAC10aF683`, `OptimismPortal` `0xc5c5D157928BDBD2ACf6d0777626b6C75a9EAEDC` |
| commit | an **output root** game of type **42** (OP Succinct Lite), one every 1,800 L2 blocks (30 minutes) |
| commit id | game index |
| valid when | `isGameClaimValid(game)`, about 7 days after creation; or with `minAgeSec`, unchallenged and that old ([below](#early-acceptance)) |
| verifier | [`OPFaultVerifier`](../packages/contracts/src/op/OPFaultVerifier.sol)`(AnchorStateRegistry, 42220, maxL2SequenceLag, minAgeSec)` |
| `verifyName` gas | ~0.65M |

Celo's batcher posts EigenDA certificates (alt-DA), not blobs, so its batch inbox variant reads EigenDA blobs: `celo-inbox` ([eigenda-inbox.md](eigenda-inbox.md)).

## Game type 42: OP Succinct Lite

Celo's respected game type is `OPSuccinctFaultDisputeGame` v2.1.0 ([op-succinct](https://github.com/succinctlabs/op-succinct), `contracts/src/fp/`). A proposer posts an output root. Anyone on the challenger list can `challenge()` it within `maxChallengeDuration` (3.5 days), and the proposer then has `maxProveDuration` (1 day) to `prove()` it with an SP1 proof of the L2 blocks since the parent game. Unchallenged, it resolves for the defender after 3.5 days, and the registry's 3.5-day airgap (`disputeGameFinalityDelaySeconds`) makes it valid after about 7.

- A game builds on its **parent** (a game index in `extraData`, or the anchor): the proof starts from the parent's root claim, a game resolves only after its parent, and it loses if the parent loses.
- `claimData().status` is its `ProposalStatus`: 0 unchallenged, 1 challenged, 2 proven without a challenge, 3 proven after one, 4 resolved.
- **Permissioned.** The game's `AccessManager` (`0x2c4e8F333224139193790fB27Fc99b926061d889`) lists who may propose and who may challenge: 2 proposers and 6 challengers, set at L1 block 26,427,316, and not `address(0)` for either. Proposing opens to anyone after 14 days with no proposal (`FALLBACK_TIMEOUT`); challenging never does. So even finalized games rely on one of the 6 challengers acting within 3.5 days.

What this repo relies on is the standard `IDisputeGame` surface:

- `rootClaim` is a standard (version 0) output root. The indexer checks it against the output root it rebuilds from L2 for every game, as on every OP chain.
- `extraData` is `l2BlockNumber (32) . parentIndex (4)`. `decodeGameClaim` reads the first word as the L2 block.
- `l2SequenceNumber()` is the L2 block number, so `maxL2SequenceLag` is in **blocks**. Celo makes one block a second (since its L2 genesis; checked from 31,056,500 to the head), so 86,400 blocks is a day.
- `status()` uses the standard `GameStatus`, and validity, blacklisting and retirement come from the `AnchorStateRegistry`.

## Early acceptance

`OPFaultVerifier` and the indexer accept a type-42 game before it's final (`minAgeSec > 0`, [optimism.md](optimism.md#early-acceptance-minagesec)) when it is proper, respected, not lost, at least `minAgeSec` old, and its `claimData().status` is 0, 2 or 3: unchallenged, or challenged and answered with a ZK proof. The indexer marks a challenged game invalid for good, even if it's proven later; the verifier accepts it again once proven.

The parent isn't checked. That holds under the same assumption as on Optimism: an honest challenger challenges a wrong root claim within `minAgeSec`. op-succinct's challenger does so for every game whose output root is wrong, and also for every unchallenged game whose parent lost (`challenger.rs`, `sync_game`). So a bad game on a bad parent is challenged too. On Celo the challenger set is the 6 listed above.

Checked live (2026-11-25): with `minAgeSec` = 600, game 42905 (L2 block 83,731,108, created about 20 minutes after it) was valid 45 minutes after its L2 block, and `bun run prove` resolved `raffy.eth` from the mock through it, matching `nameForAddr` at that block.

## Registrar

ENS hasn't deployed its L2ReverseRegistrar on Celo yet. The deployment points at a mock with `setNameForAddr`, `nameForAddr` and the `NameForAddrChanged` event, and names at slot 0 (`PLAIN_LAYOUT`). The indexer rebuilds storage from that event, so a registrar without it can't be indexed.

A commit for a block before the registrar existed can't be used: the verifier reverts with `AccountNotFound(registrar)`. With finalized games only, that lasts about 7 days after the registrar is deployed, and it will happen again when the real one is.

## RPC

Our drpc key answered "Chain not allowed for this key" for Celo (enable the chain for the key in drpc's dashboard), so set `RPC_URL_42220` until it does. Checked 2026-11-25:

| provider | `eth_getProof` | `eth_getLogs` |
|---|---|---|
| `https://forno.celo.org` (public) | archive (700k blocks back) | up to 5,000 blocks |
| Alchemy (`celo-mainnet`) | archive | fails over any range ("JSON is not a valid request object") |
| Infura (`celo-mainnet`) | only near the head | up to 10,000 blocks |

forno does both, so `RPC_URL_42220=https://forno.celo.org` is enough. `logStep` is 5,000. The L2's finalized head trails its tip by about 1,000 blocks (~16 minutes).
