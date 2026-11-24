// The indexer's log: colored on a terminal only, and by what a line reports.

import { expect, test } from "bun:test";
import { createLog, lineColor, useColor } from "@primary-name-gateway/registrar-indexer";

test("color only on a terminal, never with NO_COLOR, always with FORCE_COLOR", () => {
	expect(useColor({ isTTY: true }, {})).toBeTrue();
	expect(useColor({ isTTY: false }, {})).toBeFalse(); // piped: production logs
	expect(useColor({ isTTY: true }, { NO_COLOR: "1" })).toBeFalse();
	expect(useColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBeTrue();
	expect(useColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBeTrue(); // "0" doesn't force, the terminal still counts
});

test("lines are colored by what they report", () => {
	expect(lineColor("tick failed:")).toBe(31);
	expect(lineColor("game 26741: invalid (blacklisted)")).toBe(31);
	expect(lineColor("batch 2648: L2 block 1 is above the finalized head 0: trying an earlier batch")).toBe(33);
	expect(lineColor("getLogs rate limited: retrying the same 5000 blocks in 2s")).toBe(33);
	expect(lineColor("game 26741: valid (L2 block 59214360)")).toBe(32);
	expect(lineColor("commit 2648: L2 block 1, 2 changes, storageHash 0x (valid)")).toBe(32);
	expect(lineColor("caught up: +2 changes in 10 blocks (1s), 2 through L2 block 10")).toBe(32);
	expect(lineColor("commit 2648: L2 block 1, 2 changes, storageHash 0x (pending)")).toBeUndefined();
});

test("without color the line is plain", () => {
	const lines: unknown[][] = [];
	const original = console.log;
	console.log = (...a: unknown[]) => lines.push(a);
	try {
		createLog(false)("tick failed:", 1);
		createLog(true)("tick failed:", 1);
	} finally {
		console.log = original;
	}
	expect(lines[0].slice(1)).toEqual(["tick failed:", 1]);
	expect(String(lines[0][0])).not.toContain("\x1b[");
	expect(lines[1][1]).toBe("\x1b[31mtick failed:\x1b[0m");
});
