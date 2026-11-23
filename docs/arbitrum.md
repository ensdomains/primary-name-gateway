# Arbitrum

Arbitrum One settles to L1 through **BoLD** assertions: a validator posts an assertion naming an L2 block (by hash), and after the confirm period without a successful challenge it is confirmed. The indexer commits to assertions, the gateway serves Merkle-Patricia rows as for OP Stack chains ([chunks](optimism.md#chunks)), and [`ArbitrumVerifier`](../packages/contracts/src/arbitrum/ArbitrumVerifier.sol) checks an assertion against the rollup. Like `OPFaultVerifier`'s `minAgeSec`, it can accept assertions before confirmation (`minAgeBlocks`).

| chain | Arbitrum One |
|---|---|
| chain id / coin type | 42161 / `0x8000a4b1` |
| registrar | `0x0000000000D8e504002cC26E3Ec46D81971C1664`, created at L2 block 349,263,357, **plain** layout (names at slot 0; no `owner()`) |
| L1 rollup | `RollupProxy` `0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0` (BoLD) |
| commit | an assertion whose machine finished; id = L1 block × 10000 + log index of its `AssertionCreated` |
| valid when | confirmed: `confirmPeriodBlocks` = 45,818 L1 blocks (about 6.4 days) after creation; or with `minAgeBlocks`, unchallenged and that old |
| verifier | `ArbitrumVerifier(rollup, minAgeBlocks, maxAgeBlocks)` |
| scripts | `bun run indexer:arbitrum` / `gateway:arbitrum` (ports 8104 / 8204), `bun run prove <address> arbitrum` |

## Assertions

Each assertion is a node in a tree rooted at the genesis assertion ([BoLD](https://docs.arbitrum.io/how-arbitrum-works/bold/gentle-introduction), [nitro-contracts](https://github.com/OffchainLabs/nitro-contracts) `src/rollup/`):

- `assertionHash = keccak256(abi.encodePacked(parentAssertionHash, keccak256(abi.encode(afterState)), afterInboxBatchAcc))`. All three are in the `AssertionCreated` event; `afterInboxBatchAcc` is the sequencer inbox accumulator after the assertion's last batch.
- `afterState.globalState.bytes32Vals[0]` is the **L2 block hash** (`[1]` is the send root), and `afterState.machineStatus` must be `FINISHED` (1).
- `getAssertion(hash)` returns `{firstChildBlock, secondChildBlock, createdAtBlock, isFirstChild, status, configHash}`. `status` is `Pending` (1) or `Confirmed` (2). A nonzero `secondChildBlock` means a rival child exists: a challenge.
- `latestConfirmed()` is the newest confirmed assertion.

Measured on mainnet (2026-11-23): an assertion about every 300 L1 blocks (an hour), the newest confirmed one created 46,114 L1 blocks (6.4 days) ago, and every check below holds on real data (`test/fixtures/arbitrum.json`, from [arbitrum-fixture.ts](../scripts/arbitrum-fixture.ts)):

- the assertion hash recomputes from the event;
- our header encoder (`encodeBlockHeader`) reproduces the L2 block hash: Arbitrum's extra RPC fields (`l1BlockNumber`, `sendCount`, `sendRoot`) aren't part of the header;
- `eth_getProof` (Alchemy) roots in the header's `stateRoot`, and the registrar's name slot proves `lillithh.eth`.

## The proof: an assertion chain

A confirmed assertion's hash can be checked directly, but the after state it commits to can't be read back from the rollup: the hash has to be recomputed from the parent. So the commit proof (`ArbitrumCommitProof`, `encodeArbitrumCommitProof` in [arbitrum.ts](../packages/shared/src/arbitrum.ts)) is a chain:

```
anchor                      a confirmed assertion
chain                       (afterStateHash, afterInboxBatchAcc) per assertion, from the anchor's child to the commit's
afterState                  the commit assertion's (its hash must be the last afterStateHash)
l2Header                    RLP header of the L2 block afterState names
```

The verifier walks it: each step recomputes the child's hash and reads its node.

- **`minAgeBlocks == 0`:** every link must be confirmed. The indexer's proof is one link, anchored at the commit's parent (a confirmed assertion's parent is confirmed).
- **`minAgeBlocks > 0`:** a link may be pending if its parent has no rival child (`secondChildBlock == 0`). The anchor is the last confirmed ancestor, so the chain is as long as the unconfirmed stretch: up to about 150 links (one an hour for 6.4 days), each one `getAssertion` call. The trust: an honest validator challenges a bad assertion within `minAgeBlocks`. A challenge on the way (a rival anywhere from the anchor to the commit) is refused.
- **Freshness and age:** `latest` is the newest acceptable assertion's L1 block: `latestConfirmed()`'s `createdAtBlock`, or `block.number - minAgeBlocks`. The commit's assertion must have `createdAtBlock <= latest` (old enough) and `createdAtBlock + maxAgeBlocks >= latest` (fresh enough).
- Then: `keccak256(l2Header) == afterState.globalState.bytes32Vals[0]`, the state root is header field 3, and the account and storage proofs are Merkle-Patricia (`EthTrie`), as for OP Stack chains.

[`ArbitrumVerifier.t.sol`](../packages/contracts/test/ArbitrumVerifier.t.sol) runs the real fixture against a mock rollup holding the real assertions' nodes: a confirmed assertion resolves `lillithh.eth` and an unset address through `L2ReverseResolver`; its pending child is refused without `minAgeBlocks`, accepted at exactly `minAgeBlocks` old and refused one block younger; a rival child, a wrong inbox accumulator, a tampered after state, the wrong header, a stale assertion, an unconfirmed anchor and an empty chain are each refused.

## The indexer

[arbitrum.ts](../packages/registrar-indexer/src/arbitrum.ts) (`INDEXER_CHAIN=arbitrum`):

- **Discovery:** `AssertionCreated` events on finalized L1, from a cursor (`arbitrumNextL1Block`), 10,000 L1 blocks per `eth_getLogs` (Infura's limit). On first start, and after downtime, it starts `INDEXER_LOOKBACK_L1_BLOCKS` back (default: the confirm period and a day, so there are confirmed assertions). Each finished assertion becomes a commit: its L2 block (the header by hash), the registrar's account proof there (archive: Alchemy), and the one-link proof. Assertions are taken in order; one that fails is retried next tick.
- **Status**, each tick, from one batched `getAssertion` per held assertion on finalized L1:
  - confirmed: valid;
  - with `INDEXER_MIN_AGE_BLOCKS` (must equal the verifier's `minAgeBlocks`): a pending assertion that old, with an unchallenged chain back to a confirmed one, is valid, and its proof is rebuilt with that chain;
  - a valid but unconfirmed assertion whose chain gets a rival becomes invalid.
- **Events:** the registrar's history is 177M L2 blocks. Arbitrum's public RPC answers `eth_getLogs` over 10,000,000 blocks (Infura 10,000, drpc's free plan 100), so `ARBITRUM.wideLogsRPC` is preferred for logs: the whole replay is about 18 calls.

## Checked on mainnet (2026-11-23)

`bun run indexer:arbitrum` from an empty database, with Alchemy for proofs and a public L1 node (Infura was rate-limiting):

- The registrar's whole history (272 events over 177M L2 blocks) replayed in 3 seconds through the wide-logs endpoint.
- 179 assertions over the lookback (53,018 L1 blocks): every replayed storage root matched Arbitrum's `eth_getProof`. 24 confirmed ones became valid; the newest is the rollup's `latestConfirmed()`.
- `bun run prove <address> arbitrum`, against the real rollup on an L1 fork, through `gateway:arbitrum`:

| mode | proof | behind finalized | response | gas |
|---|---|---|---|---|
| confirmed only | 1 link from a confirmed assertion | 6d12h | 6.7 KB | about 600,000 |
| `INDEXER_MIN_AGE_BLOCKS=1800` (6 hours), verifier `--min-age 1800` | 149 links from the last confirmed one | 7h26m | 16.4 KB | 2,100,214 |

- Restarted with `INDEXER_MIN_AGE_BLOCKS=1800`, the indexer checked its valid assertions again and accepted the 149 pending ones over 6 hours old (6 younger ones stayed pending). A confirmed-only verifier rejects their proofs with `NotConfirmed` on the first pending link, as it should; the same database serves either mode after a restart, since the indexer records `minAgeBlocks` and re-checks on a change.

## Compared with unruggable-gateways

The verifier follows unruggable's `BoLDVerifierLib` ([contracts/arbitrum](https://github.com/unruggable-labs/unruggable-gateways/tree/main/contracts/arbitrum), MIT) and `BoLDRollup.ts` ([src/arbitrum](https://github.com/unruggable-labs/unruggable-gateways/tree/main/src/arbitrum)):

- Same chain walk, the same rival rule for pending links, and the same window: unruggable's `_checkWindow(latest, got)` with `latest` = the last confirmed assertion's `createdAtBlock`, or `block.number - minAgeBlocks`.
- The proof here carries `bytes32[]` pairs instead of packed bytes, and the verifier implements `IL2StorageVerifier` (one storage root per commit) instead of the GatewayVM.
- Unruggable keeps assertions in memory and builds a chain per request; the indexer stores each assertion as a commit and rebuilds an early commit's chain once, when it becomes valid.
- Pre-BoLD (Nitro, `NitroVerifierLib`: nodes with `latestNodeCreated`, `getNode`) isn't implemented: Arbitrum One and Nova moved to BoLD.

## Open

- The confirm period makes finality-only proofs about 6.4 days behind; `minAgeBlocks` (for example 1,800 = 6 hours) brings that down, with the chained proof's gas growing with the unconfirmed stretch (about 150 `getAssertion` calls at most).
- Arbitrum Nova (`0xE7E8cCC7c381809BDC4b213CE44016300707B7Bd`, BoLD) would be another deployment of the same code, if it has a registrar.
- No offline end-to-end test yet (a fake BoLD rollup and L2 like `fake-rollup.ts`); the verifier is tested in forge on mainnet data, and the indexer live.

## References

- BoLD: [gentle introduction](https://docs.arbitrum.io/how-arbitrum-works/bold/gentle-introduction), [OffchainLabs/bold](https://github.com/OffchainLabs/bold)
- [nitro-contracts](https://github.com/OffchainLabs/nitro-contracts): `src/rollup/Assertion.sol`, `AssertionState.sol`, `IRollupCore.sol`, `src/state/GlobalState.sol`, `Machine.sol`
- [Arbitrum contract addresses](https://docs.arbitrum.io/build-decentralized-apps/reference/contract-addresses)
- unruggable-gateways: [contracts/arbitrum](https://github.com/unruggable-labs/unruggable-gateways/tree/main/contracts/arbitrum), [src/arbitrum/BoLDRollup.ts](https://github.com/unruggable-labs/unruggable-gateways/blob/main/src/arbitrum/BoLDRollup.ts)
- [ENSIP-19](https://docs.ens.domains/ensip/19) (coin type `0x80000000 | 42161`)
