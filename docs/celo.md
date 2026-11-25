# Celo

Celo (chain id 42220) has been an OP Stack L2 since block 31,056,500 (2025-03-26). Before that block it was its own L1. It makes one block a second, and its data goes to EigenDA (alt-DA), not to L1 blobs. Checked on chain 2026-11-25.

## Commitments

`CELO_MAINNET` in [chains.ts](../packages/shared/src/chains.ts) is an `op` deployment: dispute games, finalized only.

| | |
|---|---|
| AnchorStateRegistry | `0x8fE58d2168b5412Cf1Bd212cE6137f8b7300222d` (v3.5.0) |
| DisputeGameFactory | `0xFbAC162162f4009Bb007C6DeBC36B1dAC10aF683` |
| OptimismPortal | `0xc5c5D157928BDBD2ACf6d0777626b6C75a9EAEDC` |
| respected game type | `42`: `OPSuccinctFaultDisputeGame` v2.1.0 (OP Succinct Lite) |
| games | every 1,800 L2 blocks (30 minutes) |
| finality | 3.5-day challenge window, then the registry's 3.5-day airgap: ~7 days |

A type-42 game is optimistic: a proposer posts an output root, and a challenger who disputes it forces the proposer to answer with a ZK proof within a day (`maxProveDuration`). Its `extraData` is the L2 block number followed by the parent game's index (4 bytes), and its root claim is a standard output root. So `OPFaultVerifier` and the indexer handle it unchanged: `isGameClaimValid`, `l2SequenceNumber`, `rootClaim`.

**Early acceptance (`minAgeSec`) isn't supported for type 42.** The verifier and the indexer only know how to tell that FaultDisputeGame and Base's AggregateVerifier games are unchallenged. For any other type they accept finalized games only. Supporting it would mean reading `claimData().status` (0 = unchallenged, 2 = unchallenged with a valid proof), and handling the parent chain: a game whose parent loses also loses, and nobody needs to challenge it directly.

**No batch inbox.** Celo's batcher posts EigenDA certificates, not blobs, so `OPBatchInboxVerifier` doesn't apply.

## Registrar

There's no ENS L2ReverseRegistrar on Celo yet. The deployment points at a mock, `0x07e0B99DDFcc4F0750ab5FB46084cAd9235a918b`, created at L2 block 83,729,711. It has `setNameForAddr`, `nameForAddr` and the `NameForAddrChanged` event, with names at slot 0 (`PLAIN_LAYOUT`). The indexer rebuilds storage from that event, so a registrar without it can't be indexed.

Until a game newer than the registrar's creation is valid (about 7 days after it), every commit the indexer can serve names a block where the registrar doesn't exist. The verifier then reverts with `AccountNotFound(registrar)`. That's expected, and it will happen again when the real registrar is deployed.

## RPC

Our drpc key answered "Chain not allowed for this key" for Celo (enable the chain for the key in drpc's dashboard), so set `RPC_URL_42220` until it does. Checked 2026-11-25:

| provider | `eth_getProof` | `eth_getLogs` |
|---|---|---|
| `https://forno.celo.org` (public) | archive (700k blocks back) | up to 5,000 blocks |
| Alchemy (`celo-mainnet`) | archive | fails over any range ("JSON is not a valid request object") |
| Infura (`celo-mainnet`) | only near the head | up to 10,000 blocks |

forno does both, so `RPC_URL_42220=https://forno.celo.org` is enough. `logStep` is 5,000. The L2's finalized head trails its tip by about 1,000 blocks (~16 minutes).

```sh
RPC_URL_42220=https://forno.celo.org bun run indexer:celo   # :8105
bun run gateway:celo                                        # :8205
RPC_URL_42220=https://forno.celo.org bun run prove <address> celo
```
