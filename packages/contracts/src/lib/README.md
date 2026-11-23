Vendored libraries (each file keeps its original header):

- `optimism/`, from [ethereum-optimism/optimism](https://github.com/ethereum-optimism/optimism) (MIT):
  - `Bytes.sol`, `RLPReader.sol`, `RLPErrors.sol` from
    [op-contracts/v4.0.0](https://github.com/ethereum-optimism/optimism/tree/op-contracts/v4.0.0/packages/contracts-bedrock/src/libraries)
    (only import paths changed)
  - `MerkleTrie.sol`, `SecureMerkleTrie.sol` from
    [f4cd5c0](https://github.com/ethereum-optimism/optimism/tree/f4cd5c0e103f981724d2b64ee36f3d0da175b0ca/packages/contracts-bedrock/contracts/libraries/trie),
    the last version that supports exclusion proofs (needed for unset slots; removed in the next commit,
    `4d13f0a`, which their header links). Import paths changed, and `MerkleTrie` has one added check (as in
    [unruggable-gateways](https://github.com/unruggable-labs/unruggable-gateways/blob/7426ac57509e2023a673956439eed29998d2e371/contracts/eth/MerkleTrie.sol)):
    a value in a branch node must be the last node of the proof.
- `linea/Poseidon2.sol` from
  [LFDT-Lineth/lineth-monorepo@79c58ae](https://github.com/LFDT-Lineth/lineth-monorepo/blob/79c58ae9d7253e07142b41c0f213a5a670576bfa/contracts/src/libraries/Poseidon2.sol)
  (modified: `hash()` and `padBytes32()` are `internal`, and `hash()` reads its message from memory)

Linea's `SparseMerkleProof.sol` is AGPL-3.0 and is not vendored: `../linea/LineaTrie.sol` is an
independent implementation (multiproofs with sibling hashes).
