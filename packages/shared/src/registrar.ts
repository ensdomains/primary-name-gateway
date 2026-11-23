import { followSlot, type SlotStorage } from "@ensdomains/merkle-builder";
import { bytesToBigInt, type Hex, hexToBytes, keccak256, numberToBytes, padHex, parseAbi } from "viem";

// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/reverseRegistrar/L2ReverseRegistrar.sol
// layout: slot 0 = mapping(address => string) _names
export const SLOT_NAMES = 0n;

export const REGISTRAR_ABI = parseAbi(["event NameForAddrChanged(address indexed addr, string name)"]);

// storage slot of names[addr] (the string header)
export function primarySlot(addr: Hex): Uint8Array {
	return followSlot(SLOT_NAMES, hexToBytes(padHex(addr, { size: 32 })));
}

export function setPrimaryName(storage: SlotStorage, addr: Hex, name: Uint8Array) {
	storage.setBytes(primarySlot(addr), name);
}

// data slots of a solidity string whose header word is `header` (empty for short strings)
// mirrors L2ReverseResolver._readBytes()
export function dataSlots(slot: Uint8Array, header: Uint8Array): Uint8Array[] {
	if (!header.length || !(header[header.length - 1] & 1)) return [];
	const size = bytesToBigInt(header) >> 1n;
	const count = (size + 31n) >> 5n;
	const base = BigInt(keccak256(slot));
	const slots: Uint8Array[] = [];
	for (let i = 0n; i < count; i++) slots.push(numberToBytes(base + i, { size: 32 }));
	return slots;
}
