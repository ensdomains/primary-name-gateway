Vendored libraries (MIT):

- `optimism/` — `Bytes.sol`, `RLPReader.sol`, `RLPErrors.sol` from
  [ethereum-optimism/optimism@op-contracts/v4.0.0](https://github.com/ethereum-optimism/optimism/tree/op-contracts/v4.0.0/packages/contracts-bedrock/src/libraries)
  (only import paths changed)
- `unruggable/` — `MerkleTrie.sol`, `SecureMerkleTrie.sol` from
  [unruggable-labs/unruggable-gateways@7426ac5](https://github.com/unruggable-labs/unruggable-gateways/tree/7426ac57509e2023a673956439eed29998d2e371/contracts/eth),
  a fork of Optimism's trie library that still supports exclusion proofs (needed for unset slots)
