# The registrar contract

An L2 reverse registrar stores the [ENSIP-19](https://docs.ens.domains/ensip/19) primary names of one chain:
for each address, the name it has chosen on that chain. Users set names on the L2, and L1 resolves
`{addr}.{coinType}.reverse` → `name()` by proving the registrar's storage (this repo).

It is deployed at the same address on every supported chain:

```
0x0000000000D8e504002cC26E3Ec46D81971C1664
```

Source: [ens-contracts `contracts/reverseRegistrar/`](https://github.com/ensdomains/ens-contracts/tree/staging/contracts/reverseRegistrar)
(`StandaloneReverseRegistrar.sol`, `L2ReverseRegistrar.sol`, `L2ReverseRegistrarWithMigration.sol`).

## Storage layouts

Everything this repo proves is one Solidity `mapping(address => string) _names`. There are two variants
of the contract, and they differ in what else is in storage:

| variant | contract | slot 0 | slot 1 |
|---|---|---|---|
| plain | `L2ReverseRegistrar` | `_names` | — |
| Ownable | `L2ReverseRegistrarWithMigration is L2ReverseRegistrar, Ownable` | `_names` | `_owner` |

- `_names` is declared in `StandaloneReverseRegistrar`, the base of `L2ReverseRegistrar`. `coinType` is
  `immutable` (in code, not storage) and `ERC165` / `SignatureUtils` have no state.
- The migration variant inherits `L2ReverseRegistrar` first, so its state comes first: `_names` at 0,
  OpenZeppelin v5 `Ownable._owner` at 1.

Deployed (checked 2026-11-22 with `eth_getStorageAt` and `owner()`):

| chain | coin type | variant |
|---|---|---|
| OP Mainnet (10) | `0x8000000a` | plain |
| Linea (59144) | `0x8000e708` | plain |
| Arbitrum One (42161) | `0x8000a4b1` | plain |
| Scroll (534352) | `0x80082750` | plain |
| Base (8453) | `0x80002105` | Ownable: slot 1 = `owner()` = `0xf9Bb…63e9` |

In code the layout is a parameter, not an assumption: `RegistrarLayout { namesSlot, ownerSlot? }`
(`packages/shared/src/registrar.ts`, per deployment in `chains.ts`), `L2ReverseResolver(namesSlot)` and
`GatewayConfig.layout`. The opposite order (owner at slot 0, names at slot 1) is just another layout:
the offline Linea test uses it on purpose.

### Where a name lives

- header slot: `slot = keccak256(abi.encode(addr, namesSlot))`
- Solidity `string` layout ([docs](https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#bytes-and-string)):
  - fewer than 32 bytes: the data, left-aligned, with `length * 2` in the lowest byte of the header
  - 32 bytes or more: the header is `length * 2 + 1`, and the data is in `ceil(length / 32)` slots
    starting at `keccak256(slot)`
- An address without a name has an empty header (slot unset), which is proven with an exclusion proof.

`L2ReverseResolver` verifies the header and the data slots together (`NameProof.dataSlots` says how many,
and must agree with the header).

## Storage is fully determined by events

Every write to the registrar's storage emits an event that carries the new value:

| event | emitted by | storage effect |
|---|---|---|
| `NameForAddrChanged(address indexed addr, string name)` | `StandaloneReverseRegistrar._setName` (`setName`, `setNameForAddr`, `setNameForAddrWithSignature`, `setNameForOwnableWithSignature`), and `batchSetName` in the migration variant | `_names[addr] = name` |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` | `Ownable` constructor, `transferOwnership`, `renounceOwnership` (Ownable variant only) | `_owner = newOwner` (zero clears the slot) |

So the storage at any block is a fold over these events in `(block, logIndex)` order, starting from empty
storage. Writing a string the Solidity way also clears the data slots of a longer previous value;
merkle-builder's `setBytes` does the same. `applyChange()` in `packages/shared/src/registrar.ts` applies one
event, and the indexer reads both events from the L2 (`RPCChangeReader`) when the layout has an owner slot.

Two details matter when rebuilding the trie, rather than just the key/value storage:

- **Merkle-Patricia (OP Stack)**: the trie is a function of the key/value set, so event order within a
  block doesn't matter.
- **Linea (Shomei sparse Merkle trie)**: leaves get indices in insertion order, and the slots first written
  in a block are inserted in `hkey` order after the block. The indexer buffers each L2 block's changes and
  applies them together (`LineaStorageTrie.commit()`), matching Shomei.

### Checked, not assumed

The indexer never trusts the replay. For every commit it fetches the registrar's account proof from the L2
at that block (`eth_getProof` / `linea_getProof`) and refuses the commit if the replayed storage root
differs (`RegistrarIndexer.addCommit`). A storage write without an event, a missed event, or a wrong
layout shows up there as a `storage hash mismatch`, not as a wrong name.
