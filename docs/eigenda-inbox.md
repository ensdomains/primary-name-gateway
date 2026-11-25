# EigenDA batch inbox

The batch inbox ([op-batch-inbox.md](op-batch-inbox.md)) for an OP Stack chain whose batches go to EigenDA (alt-DA) instead of L1 blobs: Celo. The batcher posts a certificate to the batch inbox, the batch is an EigenDA blob, and the certificate commits to the blob. Everything after the blob is the same as on Optimism and Base: frame 0, partial brotli, the batch prefix, and the parent L2 header. Same trust: the **batcher key**. Built and checked on mainnet 2026-11-25.

| deployment | `celo-inbox` (kind `inbox`, `eigenDA` set in [chains.ts](../packages/shared/src/chains.ts)) |
|---|---|
| batch inbox | `0xff00000000000000000000000000000000042220`, `SystemConfig` `0x89E31965D844a309231B1f17759Ccaf1b7c09861` |
| EigenDA | `EigenDADirectory` `0x64AB2e9A86FA2E183CB6f01B2D4050c1c2dFAad4` (on L1; `RELAY_REGISTRY` names the relays) |
| commit | an EigenDA blob that starts a channel; id = L1 block × 10000 + transaction index × 10 |
| verifier | [`EigenDAInboxVerifier`](../packages/contracts/src/eigen/EigenDAInboxVerifier.sol)`(SystemConfig, BatchInbox, maxOriginLag, maxL1BlockLag)`, on [`OPInboxVerifierBase`](../packages/contracts/src/op/OPInboxVerifierBase.sol) like `OPBatchInboxVerifier` |
| gas | `verifyStorageRoot` 2.05M, `verifyName` 2.29M (Celo's brotli header is small: 240 bytes) |
| delay | ~25 minutes behind the tip (measured: Celo's finalized head trailed by 25 minutes) |

## What the batcher posts

About every 10 L1 blocks, an EIP-1559 transaction (no blobs) from the batcher to the inbox, with about 2 KB of calldata:

- `0x01` alt-DA, `0x01` generic commitment, `0x00` EigenDA, `0x02` certificate version, then an `EigenDACertV3` in RLP: `[batchHeader, blobInclusionInfo, nonSignerStakesAndSignature, signedQuorumNumbers]`.
- `blobInclusionInfo[0]` is the blob certificate, whose header is `[version, quorumNumbers, commitments, paymentHeaderHash]`, and `commitments` is `[G1 commitment, G2 length commitment, G2 length proof, length]` (BN254, length in 32-byte symbols: 16,384 on Celo).

The batcher signs the transaction, so the commitment is the batcher's word, like a blob's versioned hash. The certificate's own validity (EigenDA's operators signed the batch) isn't checked, since the batcher is trusted anyway. Derivation drops a batch whose certificate is invalid, so that is the same accepted risk as an orphaned parent ([op-batch-inbox.md](op-batch-inbox.md#trust)). The verifier could also call EigenDA's `CertVerifierRouter`, but the certificate would have to be re-encoded from RLP to ABI.

## The blob

- **Fetching it:** EigenDA's relays serve blobs over gRPC: `relay.Relay/GetBlob {1: blob_key}` returns `{1: blob}`, with no credentials. The relay's URL comes from the RelayRegistry (`relayKeyToUrl`; relay 0 is `relay-0-mainnet-ethereum.eigenda.xyz`). The key is `keccak(abi.encode(keccak(abi.encode(version, sorted quorums, commitments)), paymentHeaderHash))` (EigenDA's `ComputeBlobKey`). [eigenda.ts](../packages/registrar-indexer/src/eigenda.ts) speaks enough gRPC for it over `node:http2`, with no dependency: a 512 KB blob in about 0.6 s.
- **The payload:** a blob is the coefficients of a polynomial `p`, and the payload is its evaluations at `w^0, w^1, …`, where `w` is the blob size's root of unity (EigenDA's default, `PolynomialFormEval`). `w` is EigenDA's `Scale2RootOfUnity[log2(n)]`, from its 2^28-th root squared down. An FFT (13 ms) gives the evaluations. The first is a header (`0x00`, version `0x00`, the payload's length as a big-endian uint32, zeros), then 31 bytes per element after a `0x00` byte. The payload is OP batcher data: derivation version 0, then frames.

## The proof: `EigenDABlob`

[`EigenDABlob.verify`](../packages/contracts/src/eigen/EigenDABlob.sol) checks the first `k` evaluations against the commitment. The points `w^0..w^(k-1)` aren't a subgroup, unlike the first EIP-4844 field elements, so:

- The prover divides `p` by `Z = ∏(X − w^i)`, which leaves the interpolation `I` of those evaluations as the remainder, and commits to the quotient `q`. `q` is a polynomial only if the evaluations are `p`'s.
- `z = keccak(commitment, q's commitment, length, evaluations) mod r`. The proof (224 bytes) is `q`'s commitment, `p(z)`, and KZG openings of `p` and `q` at `z`.
- The verifier computes `I(z)` with barycentric weights. Since the points form a geometric sequence, `Z'(w^i) = w^(i(k−1)) ∏_{d≤i}(1 − w^−d) ∏_{d<k−i}(1 − w^d)` comes from prefix products: O(k), one inversion. It takes `q(z) = (p(z) − I(z)) / Z(z)` and checks both openings with one `ecPairing` (combined with a random `γ`): `e(C − y·G + z·π, G2) = e(π, τ·G2)`.
- About 180k gas for 14 evaluations (Celo's batches need 14), 191k for 20.

**EigenDA's trusted setup.** The verifier needs τ·G2: point 1 of `resources/srs/g2.point` in EigenDA's repo, a constant. The prover needs the first `n` points of `g1.point` (gnark's compressed format, 32 bytes each). `EigenDAKZG.load` downloads only those with a range request (512 KB for 16,384) into `data/eigenda/`. They're checked against each blob's certificate: the indexer recomputes the commitment before using a blob. A proof takes about 1.5 s (three MSMs).

## Indexer

`bun run indexer:celo-inbox` (port 8106; gateway 8206; needs `RPC_URL_42220`, see [celo.md](celo.md#rpc)) runs the inbox source ([inbox.ts](../packages/registrar-indexer/src/inbox.ts)) with the EigenDA steps: the certificate from calldata, the blob from the relay it names, the payload from the evaluations, and the proof. It shares `data/celo.sqlite` with the `celo` source. The rest is the inbox's: scanning finalized L1, a parent at or below the L2's finalized head, the replayed storage check, one commit per `INDEXER_INBOX_INTERVAL_SEC`, and invalidation by age or batcher rotation.

**Checked live (2026-11-25):** the first commit came from L1 block 26,494,351 (parent L2 block 83,734,631, the finalized head). `bun run prove 0x5105…eeee celo-inbox` deployed `EigenDAInboxVerifier` on an L1 fork and resolved `raffy.eth` from the mock registrar, matching `nameForAddr`.

## Open

- **Ethereum-DA fallback.** If EigenDA fails, an alt-DA batcher posts plain calldata or blobs instead. Those batches aren't read, so commits pause until EigenDA batches resume (liveness only). `OPBatchInboxVerifier` handles the blob case, so a deployment could use both verifiers.
- **Relay retention.** How long relays keep a blob is unchecked. The indexer only fetches blobs from the last ~300 L1 blocks.
- **Several relays.** Only the certificate's first relay key is tried.

## Tests

- [eigen-inbox.test.ts](../test/eigen-inbox.test.ts) (`test:inbox`) runs the verifier on a real Celo batch ([eigen-fixture.ts](../scripts/eigen-fixture.ts)): the registrar's storage root, and refusals (L1 block, transaction, evaluations, proof, L2 header, batcher, inbox, origin).
- [eigenda.test.ts](../test/eigenda.test.ts) (`test:kzg`) decodes the real certificate and its blob key, and round-trips a synthetic 256-symbol blob: encode, inverse FFT, evaluate, decode, prove, verify, tamper.
