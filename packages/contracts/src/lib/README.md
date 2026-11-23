Vendored libraries (MIT):

- `optimism/` — `Bytes.sol`, `RLPReader.sol`, `RLPErrors.sol` from
  [ethereum-optimism/optimism@op-contracts/v4.0.0](https://github.com/ethereum-optimism/optimism/tree/op-contracts/v4.0.0/packages/contracts-bedrock/src/libraries)
  (only import paths changed)
- `unruggable/` — `MerkleTrie.sol`, `SecureMerkleTrie.sol` from
  [unruggable-labs/unruggable-gateways@7426ac5](https://github.com/unruggable-labs/unruggable-gateways/tree/7426ac57509e2023a673956439eed29998d2e371/contracts/eth),
  a fork of Optimism's trie library that still supports exclusion proofs (needed for unset slots)

Vendored libraries (Apache-2.0, see [`linea/LICENSE`](linea/LICENSE)):

- `linea/Poseidon2.sol` from
  [LFDT-Lineth/lineth-monorepo@79c58ae](https://github.com/LFDT-Lineth/lineth-monorepo/blob/79c58ae9d7253e07142b41c0f213a5a670576bfa/contracts/src/libraries/Poseidon2.sol)
  (modified: `hash()` and `padBytes32()` are `internal`, and `hash()` reads its message from memory)

Linea's `SparseMerkleProof.sol` is AGPL-3.0 and is not vendored: `../linea/LineaTrie.sol` is an
independent MIT implementation (multiproofs with sibling hashes).
