// The services' log (shared/log.ts): colored on a terminal only, by the level each call site picks.

import { expect, test } from "bun:test";
import { createLog, toLog, useColor } from "@primary-name-gateway/shared";

test("color only on a terminal, never with NO_COLOR, always with FORCE_COLOR", () => {
	expect(useColor({ isTTY: true }, {})).toBeTrue();
	expect(useColor({ isTTY: false }, {})).toBeFalse(); // piped: production logs
	expect(useColor({ isTTY: true }, { NO_COLOR: "1" })).toBeFalse();
	expect(useColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBeTrue();
	expect(useColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBeTrue(); // "0" doesn't force; the terminal still counts
});

test("levels color the message; without color the line is plain", () => {
	const lines: unknown[][] = [];
	const colored = createLog(true, (...a) => lines.push(a));
	colored("restored", 1);
	colored.ok("valid");
	colored.warn("waiting");
	colored.error("tick failed:", new Error("x"));
	expect(lines.map((l) => l[1])).toEqual([
		"restored",
		"\x1b[32mvalid\x1b[0m",
		"\x1b[33mwaiting\x1b[0m",
		"\x1b[31mtick failed:\x1b[0m",
	]);
	const time = String(lines[0][0]);
	expect(time.startsWith("\x1b[2m") && time.endsWith("Z\x1b[0m")).toBeTrue(); // dim timestamp
	expect(lines[3][2]).toBeInstanceOf(Error); // other arguments as they are

	lines.length = 0;
	const plain = createLog(false, (...a) => lines.push(a));
	plain.error("tick failed:");
	expect(lines[0][1]).toBe("tick failed:");
	expect(String(lines[0][0])).not.toContain("\x1b[");
});

test("toLog: a plain function for every level, a Log as it is, or silence", () => {
	const got: unknown[] = [];
	const log = toLog((...a) => got.push(a.join(" ")));
	log("a");
	log.ok("b");
	log.warn("c");
	log.error("d");
	expect(got).toEqual(["a", "b", "c", "d"]);
	const real = createLog(false, () => {});
	expect(toLog(real)).toBe(real);
	toLog().error("nothing happens");
});
