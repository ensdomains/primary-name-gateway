# Alternatives: ZK and other ways to prove L2 state on L1

Research done **2026-11-24**, from web sources (mostly vendor announcements and secondary coverage, not re-verified on chain); the [Ethereum Economic Zone](#ethereum-economic-zone-checked-2026-11-25) on **2026-11-25**, from its spec, contracts and mainnet state. The question: are there other trustless ways to prove an L2 primary name on Ethereum, ZK in particular, given that ENS only needs one value at a known address and storage slot? Re-check the [status list](#to-re-check) before relying on any of it.

## The short answer

There is no shortcut that exploits "one slot". The problem has two parts:

1. **A trustless commitment to the L2's state on L1.** This is what costs days today: fault-proof finality (Optimism ~7 days, Base ~5, Arbitrum ~6.4) or ZK finality (Linea, hours).
2. **The slot under that commitment.** Already cheap: the Merkle-Patricia or Linea storage proof is a small part of the gas. Most of the 0.6–2.1M goes to checking the commitment (an Arbitrum assertion chain, for example).

The registrar's storage is part of the state root, and the root depends on every transaction in every block. Trusting "slot S = V at block B" without trusting a party therefore needs someone to verify the whole chain's execution up to B. A proof that covers only the registrar's transactions isn't enough: it wouldn't show those transactions succeeded (gas, signatures, nonces) or that nothing else changed the registrar's storage.

So ZK helps most when the L2 itself settles with validity proofs. Our design (a pluggable commitment behind `IL2StorageVerifier`, plus a cheap storage proof) gets faster and stays trustless as each chain makes that switch: a new game type or verifier, with the indexer and gateway unchanged.

## Options

| approach | trust | delay | cost and status (2026-11-24) |
|---|---|---|---|
| **The L2 adopts ZK settlement** (OP Succinct, Base Azul's ZK proof, Arbitrum with SP1) | math and L1 | ~1 h to 1 day | Free for us: the rollup pays. OP Mainnet chose Succinct in Feb 2026, not live yet. Base's `AggregateVerifier` has a 1-day path when a game has both TEE and ZK proofs, but no mainnet game has had a ZK proof or a challenge since Azul: all are TEE-only and resolve after 5 days (checked on chain, [base.md](base.md#game-type-621-aggregateverifier)). Arbitrum proves mainnet blocks in SP1, not yet in BoLD settlement. |
| **Prove the L2 ourselves**: derive and execute from the batches on L1 since the last finalized root, as OP Succinct does | math and L1, **no sequencer trust** | L1 finality plus proving, ~20–30 min | Launch-era OP Succinct cost about 0.6¢ per transaction on Base (claimed 10× cheaper since). That is every Base transaction, not just the registrar's: likely thousands of dollars a day. Fine for a quiet L2, too much for Base or Arbitrum. |
| **ZK coprocessors** (Axiom, Brevis, Herodotus) | whatever their input root is | same as part 1 | They only compress part 2 and the gas (a Groth16 check is ~250–300k gas). They don't change trust or delay. Axiom covers L1 only; Brevis covers EVM L2s. |
| **Batch inbox** | the sequencer | ~25 min | Built ([op-batch-inbox.md](op-batch-inbox.md)). Cheap. The same path as proving the L2 ourselves, minus execution and derivation, so the sequencer is trusted instead. |
| **Early acceptance** (`minAgeSec`, `minAgeL1Blocks`) | one honest challenger within that time | T + ~1 h | Built ([optimism.md](optimism.md#early-acceptance-minagesec), [arbitrum.md](arbitrum.md)). |
| **TEE** (Base's first proof), state committees (Lagrange), messaging bridges (LayerZero, Hyperlane), Polymer | hardware, an operator set, or the sequencer | minutes | Not trustless in the sense this project wants. |
| **Ethereum Economic Zone** (EEZ: Gnosis and Zisk, EF co-funded) | today one signer key; planned: real-time ZK and L1 | seconds to minutes | Each member rollup has a root on L1 (for Rollup X, its L2 block hash), so a verifier would be small. Not usable yet: no ZK proofs on mainnet, no ENS registrar on a member rollup ([below](#ethereum-economic-zone-checked-2026-11-25)). |
| **Native rollups** (`EXECUTE` precompile, EIP-8079, then EIP-8288) | L1 itself | L1 finality | Draft EIPs with a prototype (ethrex, March 2026); no fork scheduled. The cleanest long-term answer. |

### Numbers behind the "prove it ourselves" row

- OP Succinct at launch: about 0.5–1¢ per transaction (Base 0.61¢, OP Mainnet 1.34¢), with Base cheaper because its transactions use less gas. Latency of minutes to tens of minutes with a large cluster. Succinct claimed a 10× drop for Ethereum blocks afterwards; not confirmed here.
- SP1 Hypercube (real-time proving of L1 blocks): ~10 s per block on ~160 RTX 4090s (~$300–400k of hardware). A vendor claim, not audited at the time.

## Ethereum Economic Zone (checked 2026-11-25)

The EEZ ([spec](https://github.com/eez-association/eez-protocol-docs), [contracts](https://github.com/eez-association/eez-core-protocol)) aims at synchronous composability between L1 and member rollups, with Zisk proving rollup blocks in real time. `EEZ.sol` on L1 keeps a registry of rollups. Each has a `root` that proven batches advance, and how a rollup reaches L1 decides whether we can use it:

- **Native cross-chain reads don't fit.** An L1 contract can STATICCALL an L2 contract through a `CrossChainProxy`, but the read only resolves against results a builder proved and posted for that exact call while the rollup's root is unchanged (`StaticExecutionEntry`). A client's arbitrary `resolve` `eth_call` has none and fails (`ExecutionNotFound`), so it can't replace CCIP-Read.
- **The root does fit.** For Rollup X, `root` is the L2 **block hash** (its design notes). A verifier would read `rollups(id).root`, take an L2 header that hashes to it, and prove the registrar's storage from that header's state root. That's a few hundred thousand gas, the cheapest of our verifiers. Roots advance every 6 L2 blocks (12 s) while a rollup is active. The root only holds the newest block, so a proof built a little earlier would need a link back, for example the older block's hash from the L2's EIP-2935 history contract under the current root.

On mainnet (read on chain):

- `EEZ.sol` is at `0x4B2760F84B83d6b3829E30A7573B0172B6d6402C` with 6 registered rollups. Rollup 1 is Rollup X (L2 chain 696990), last verified about 2 days earlier. Rollup 2 was the only active one (verified about 34 minutes earlier, holding 0.2 ETH; which chain it is wasn't identified). Rollups 3–6 hold placeholder roots.
- **Trust today: one key.** Both active rollups have threshold 1 and use `ECDSAProofSystem` ("temporary proof system that uses ECDSA signature recovery instead of a ZK proof"): one signer attests each state transition. The same owner EOA, `0xcEAF908C05B277E92e89b51B281Ec76305b9A141`, controls both rollup contracts, and the spec gives a rollup's manager a `setRoot` escape hatch.
- Rollup X's public L2 RPC (`mainnet.eez.dev/rpc/l2`) served the recorded genesis, but its newest block was about 14 days old, and rollup 1's L1 root matched none of its blocks.
- Milestones so far: one atomic L1→L2 transfer on mainnet (October), and the Rollup X devnet at Devcon, certified by designated signers rather than ZK proofs. No testnet or mainnet dates.
- No ENS reverse registrar exists on any EEZ rollup.

Worth revisiting once a rollup ENS cares about has joined with a ZK proof system and a root its signer and owner can't move. Then the verifier above would be small and among the freshest trustless options.

## The ENS-specific angle

ENSIP-19 reverse registrars accept a name set by the user's signature, and a signature can be checked on L1 directly. It can't show the claim is still the *latest* one, though, so changing or clearing a name still needs L2 state. Not a replacement on its own.

## What it means here

- **OP Mainnet:** once OP Succinct is the respected game type, add it to `OPFaultVerifier` (a game type and how to tell it's unchallenged) and the OP source. Validity would follow ZK finality (~1 hour) instead of the 7-day window.
- **Base:** games that carry a ZK proof as well as the TEE one resolve after 1 day instead of about 5; nothing to change, but re-measure the delay. We can't make it happen ourselves: a game resolves only after its parent, so every game back to the anchor would need a ZK proof, which only Base's proposer can arrange.
- **Arbitrum:** when BoLD gets a ZK-settled path, a verifier for it.
- **Proving a chain ourselves** only makes sense for a quiet L2, or for a future ENS chain such as Namechain, where proving every block is cheap.

## To re-check

When retrying this research, start here:

- [ ] Is OP Succinct the respected game type on OP Mainnet? What's its finality?
- [ ] Do Base games carry ZK proofs routinely (1-day finality instead of ~5)? On 2026-11-24: none, ever. To re-check, read `zkProver()` and `expectedResolution()` on recent games of the factory, or count `Proved(address,uint8)` logs whose second topic is 1 (ZK).
- [ ] Is ZK settlement live in Arbitrum's BoLD? With what delay?
- [ ] Current ZK proving cost per transaction (OP Succinct, SP1, RISC Zero / Boundless and Kailua) and latency.
- [ ] Do ZK coprocessors (Brevis, Herodotus, Axiom) prove L2 state on L1 natively now?
- [ ] Native rollups: is `EXECUTE` (or its successor) scheduled for a fork?
- [ ] EEZ: does any member rollup use a ZK proof system instead of `ECDSAProofSystem`, without an owner-controlled `setRoot`? Is ENS's registrar deployed on one? Read `rollups(id)`, `lastVerifiedBlock(id)` and the rollup contract's `ProofSystemAdded` events on `0x4B2760F84B83d6b3829E30A7573B0172B6d6402C`.
- [ ] Anything new that proves one L2 storage slot on L1 without proving the whole chain.

## Sources (read 2026-11-24, EEZ 2026-11-25)

- Optimism and Succinct: [Optimism blog](https://optimism.io/blog/optimism-partners-with-succinct-as-preferred-provider-to-accelerate-zk-proving-on-the-superchain), [Succinct blog](https://blog.succinct.xyz/optimism-superchain/), [OP Succinct (GitHub)](https://github.com/succinctlabs/op-succinct), [The OP Succinct Book](https://succinctlabs.github.io/op-succinct/), [Introducing OP Succinct](https://blog.succinct.xyz/op-succinct/)
- Base: [Azul proof system](https://docs.base.org/upgrades/azul/proofs), [proof contracts](https://docs.base.org/specifications/base-protocol/proofs/proof-contracts), [Base adds ZK proofs with SP1](https://blog.succinct.xyz/base-sp1/)
- Arbitrum: [ZK settlement is coming to Arbitrum](https://blog.arbitrum.io/zk-settlement-is-coming/)
- Proving cost: [SP1 Hypercube](https://blog.succinct.xyz/sp1-hypercube/)
- Other chains: [Mantle review (Coin Bureau)](https://coinbureau.com/review/mantle-network-review)
- Coprocessors: [Space and Time comparison](https://www.spaceandtime.io/blog/best-zk-coprocessors-and-verifiable-compute-layers), [Herodotus ZK coprocessor](https://www.herodotus.cloud/en/learn/zk-coprocessor)
- Interop and committees: [Modeling security for cross-rollup interoperability (ethresear.ch)](https://ethresear.ch/t/modeling-security-for-cross-rollup-interoperability/20591), [Polymer](https://polymer-landing.pages.dev/blog/prove-anything-cross-chain/)
- Ethereum Economic Zone (read 2026-11-25): [The Block](https://www.theblock.co/post/395578/gnosis-and-zisk-announce-ethereum-economic-zone-rollup-framework-with-ethereum-foundation-co-funding), [Decrypt](https://decrypt.co/362711/ethereum-economic-zone-solve-layer-2-fragmentation), [first atomic L1-to-L2 transaction (Crowdfund Insider)](https://www.crowdfundinsider.com/2026/10/316285-ethereum-economic-zone-records-first-atomic-l1-to-l2-transaction-on-mainnet/), [Rollup X devnet (TechFlow)](https://www.techflowpost.com/en-US/newsletter/143244), [Alea Research](https://alearesearch.substack.com/p/ethereum-economic-zone-rollup-coordination), and on GitHub [eez-protocol-docs](https://github.com/eez-association/eez-protocol-docs), [eez-core-protocol](https://github.com/eez-association/eez-core-protocol), [eez-rollupX](https://github.com/eez-association/eez-rollupX)
- Native rollups: [EIP-8079](https://eips.ethereum.org/EIPS/eip-8079), [L2BEAT native rollups](https://l2beat.com/native-rollups), [prototype (The Block)](https://www.theblock.co/post/393160/)
- ENS: [Namechain, ENSIP-19 and multichain interop](https://discuss.ens.domains/t/ens-research-namechain-ensip-19-multichain-interop/21392)
