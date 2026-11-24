# Alternatives: ZK and other ways to prove L2 state on L1

Research done **2026-11-24**, from web sources (mostly vendor announcements and secondary coverage, not re-verified on chain). The question: are there other trustless ways to prove an L2 primary name on Ethereum, ZK in particular, given that ENS only needs one value at a known address and storage slot? Re-check the [status list](#to-re-check) before relying on any of it.

## The short answer

There is no shortcut that exploits "one slot". The problem has two parts:

1. **A trustless commitment to the L2's state on L1.** This is what costs days today: fault-proof finality (Optimism ~7 days, Base ~5, Arbitrum ~6.4) or ZK finality (Linea, hours).
2. **The slot under that commitment.** Already cheap: the Merkle-Patricia or Linea storage proof is a small part of the gas. Most of the 0.6–2.1M goes to checking the commitment (an Arbitrum assertion chain, for example).

The registrar's storage is part of the state root, and the root depends on every transaction in every block. Trusting "slot S = V at block B" without trusting a party therefore needs someone to verify the whole chain's execution up to B. A proof that covers only the registrar's transactions isn't enough: it wouldn't show those transactions succeeded (gas, signatures, nonces) or that nothing else changed the registrar's storage.

So ZK helps most when the L2 itself settles with validity proofs. Our design (a pluggable commitment behind `IL2StorageVerifier`, plus a cheap storage proof) gets faster and stays trustless as each chain makes that switch: a new game type or verifier, with the indexer and gateway unchanged.

## Options

| approach | trust | delay | cost and status (2026-11-24) |
|---|---|---|---|
| **The L2 adopts ZK settlement** (OP Succinct, Base Azul's ZK proof, Arbitrum with SP1) | math and L1 | ~1 h to 1 day | Free for us: the rollup pays. OP Mainnet chose Succinct in Feb 2026, not live yet. Base's `AggregateVerifier` has a 1-day path when a game has both TEE and ZK proofs, but games carry only the TEE proof in practice (hence ~5 days, [base.md](base.md)). Arbitrum proves mainnet blocks in SP1, not yet in BoLD settlement. |
| **Prove the L2 ourselves**: derive and execute from the batches on L1 since the last finalized root, as OP Succinct does | math and L1, **no sequencer trust** | L1 finality plus proving, ~20–30 min | Launch-era OP Succinct cost about 0.6¢ per transaction on Base (claimed 10× cheaper since). That is every Base transaction, not just the registrar's: likely thousands of dollars a day. Fine for a quiet L2, too much for Base or Arbitrum. |
| **ZK coprocessors** (Axiom, Brevis, Herodotus) | whatever their input root is | same as part 1 | They only compress part 2 and the gas (a Groth16 check is ~250–300k gas). They don't change trust or delay. Axiom covers L1 only; Brevis covers EVM L2s. |
| **Batch inbox** ([op-batch-inbox.md](op-batch-inbox.md)) | the sequencer | ~25 min | Cheap. The same path as proving the L2 ourselves, minus execution and derivation, so the sequencer is trusted instead. |
| **Early acceptance** (`minAgeSec`, `minAgeL1Blocks`) | one honest challenger within that time | T + ~1 h | Built ([optimism.md](optimism.md#early-acceptance-minagesec), [arbitrum.md](arbitrum.md)). |
| **TEE** (Base's first proof), state committees (Lagrange), messaging bridges (LayerZero, Hyperlane), Polymer | hardware, an operator set, or the sequencer | minutes | Not trustless in the sense this project wants. |
| **Native rollups** (`EXECUTE` precompile, EIP-8079, then EIP-8288) | L1 itself | L1 finality | Draft EIPs with a prototype (ethrex, March 2026); no fork scheduled. The cleanest long-term answer. |

### Numbers behind the "prove it ourselves" row

- OP Succinct at launch: about 0.5–1¢ per transaction (Base 0.61¢, OP Mainnet 1.34¢), with Base cheaper because its transactions use less gas. Latency of minutes to tens of minutes with a large cluster. Succinct claimed a 10× drop for Ethereum blocks afterwards; not confirmed here.
- SP1 Hypercube (real-time proving of L1 blocks): ~10 s per block on ~160 RTX 4090s (~$300–400k of hardware). A vendor claim, not audited at the time.

## The ENS-specific angle

ENSIP-19 reverse registrars accept a name set by the user's signature, and a signature can be checked on L1 directly. It can't show the claim is still the *latest* one, though, so changing or clearing a name still needs L2 state. Not a replacement on its own.

## What it means here

- **OP Mainnet:** once OP Succinct is the respected game type, add it to `OPFaultVerifier` (a game type and how to tell it's unchallenged) and the OP source. Validity would follow ZK finality (~1 hour) instead of the 7-day window.
- **Base:** games that carry a ZK proof as well as the TEE one resolve after 1 day instead of about 5; nothing to change, but re-measure the delay.
- **Arbitrum:** when BoLD gets a ZK-settled path, a verifier for it.
- **Proving a chain ourselves** only makes sense for a quiet L2, or for a future ENS chain such as Namechain, where proving every block is cheap.

## To re-check

When retrying this research, start here:

- [ ] Is OP Succinct the respected game type on OP Mainnet? What's its finality?
- [ ] Do Base games carry ZK proofs routinely (1-day finality instead of ~5)?
- [ ] Is ZK settlement live in Arbitrum's BoLD? With what delay?
- [ ] Current ZK proving cost per transaction (OP Succinct, SP1, RISC Zero / Boundless and Kailua) and latency.
- [ ] Do ZK coprocessors (Brevis, Herodotus, Axiom) prove L2 state on L1 natively now?
- [ ] Native rollups: is `EXECUTE` (or its successor) scheduled for a fork?
- [ ] Anything new that proves one L2 storage slot on L1 without proving the whole chain.

## Sources (read 2026-11-24)

- Optimism and Succinct: [Optimism blog](https://optimism.io/blog/optimism-partners-with-succinct-as-preferred-provider-to-accelerate-zk-proving-on-the-superchain), [Succinct blog](https://blog.succinct.xyz/optimism-superchain/), [OP Succinct (GitHub)](https://github.com/succinctlabs/op-succinct), [The OP Succinct Book](https://succinctlabs.github.io/op-succinct/), [Introducing OP Succinct](https://blog.succinct.xyz/op-succinct/)
- Base: [Azul proof system](https://docs.base.org/upgrades/azul/proofs), [proof contracts](https://docs.base.org/specifications/base-protocol/proofs/proof-contracts), [Base adds ZK proofs with SP1](https://blog.succinct.xyz/base-sp1/)
- Arbitrum: [ZK settlement is coming to Arbitrum](https://blog.arbitrum.io/zk-settlement-is-coming/)
- Proving cost: [SP1 Hypercube](https://blog.succinct.xyz/sp1-hypercube/)
- Other chains: [Mantle review (Coin Bureau)](https://coinbureau.com/review/mantle-network-review)
- Coprocessors: [Space and Time comparison](https://www.spaceandtime.io/blog/best-zk-coprocessors-and-verifiable-compute-layers), [Herodotus ZK coprocessor](https://www.herodotus.cloud/en/learn/zk-coprocessor)
- Interop and committees: [Modeling security for cross-rollup interoperability (ethresear.ch)](https://ethresear.ch/t/modeling-security-for-cross-rollup-interoperability/20591), [Polymer](https://polymer-landing.pages.dev/blog/prove-anything-cross-chain/)
- Native rollups: [EIP-8079](https://eips.ethereum.org/EIPS/eip-8079), [L2BEAT native rollups](https://l2beat.com/native-rollups), [prototype (The Block)](https://www.theblock.co/post/393160/)
- ENS: [Namechain, ENSIP-19 and multichain interop](https://discuss.ens.domains/t/ens-research-namechain-ensip-19-multichain-interop/21392)
