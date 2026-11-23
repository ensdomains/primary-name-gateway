import { followSlot, type SlotStorage } from "@ensdomains/merkle-builder";
import { bytesToBigInt, type Hex, hexToBytes, keccak256, numberToBytes, padHex, parseAbi } from "viem";

// See docs/registrar.md.
//
// The registrar's storage is fully determined by its events:
//   NameForAddrChanged(addr, name)          => _names[addr] = name   (every write to _names emits it)
//   OwnershipTransferred(previous, newOwner) => _owner = newOwner    (Ownable variant only)
export type RegistrarLayout = {
	namesSlot: bigint; // mapping(address => string) _names
	ownerSlot?: bigint; // address _owner (Ownable), if present
};

// L2ReverseRegistrar: _names only
export const PLAIN_LAYOUT: RegistrarLayout = { namesSlot: 0n };
// L2ReverseRegistrarWithMigration is L2ReverseRegistrar, Ownable: _names then _owner
export const OWNABLE_LAYOUT: RegistrarLayout = { namesSlot: 0n, ownerSlot: 1n };

export const REGISTRAR_ABI = parseAbi([
	"event NameForAddrChanged(address indexed addr, string name)",
	"event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

// storage slot of _names[addr] (the string header)
export function primarySlot(addr: Hex, namesSlot = 0n): Uint8Array {
	return followSlot(namesSlot, hexToBytes(padHex(addr, { size: 32 })));
}

export function setPrimaryName(storage: SlotStorage, addr: Hex, name: Uint8Array, namesSlot = 0n) {
	storage.setBytes(primarySlot(addr, namesSlot), name);
}

export function setOwner(storage: SlotStorage, owner: Hex, ownerSlot: bigint) {
	storage.setStorage(numberToBytes(ownerSlot, { size: 32 }), hexToBytes(owner));
}

// data slots of a solidity string whose header word is `header` (empty for short strings)
// mirrors L2ReverseResolver.verifyName()
export function dataSlots(slot: Uint8Array, header: Uint8Array): Uint8Array[] {
	if (!header.length || !(header[header.length - 1] & 1)) return [];
	const size = bytesToBigInt(header) >> 1n;
	const count = (size + 31n) >> 5n;
	const base = BigInt(keccak256(slot));
	const slots: Uint8Array[] = [];
	for (let i = 0n; i < count; i++) slots.push(numberToBytes(base + i, { size: 32 }));
	return slots;
}

// apply one registrar event to its storage (see docs/registrar.md)
export function applyChange(
	storage: SlotStorage,
	layout: RegistrarLayout,
	change: { kind: "name" | "owner"; addr: Hex; name: Hex },
) {
	if (change.kind === "name") {
		setPrimaryName(storage, change.addr, hexToBytes(change.name), layout.namesSlot);
	} else {
		if (layout.ownerSlot === undefined) throw new Error("ownership change without an owner slot");
		setOwner(storage, change.addr, layout.ownerSlot);
	}
}
