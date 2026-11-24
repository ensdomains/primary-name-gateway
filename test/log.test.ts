// The services' log (shared/log.ts): colored on a terminal only, by the level each call site picks.

import { expect, test } from "bun:test";
import { createLog, errorLine, toLog, useColor } from "@primary-name-gateway/shared";

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

test("errorLine: one line, viem's short message and details, never the RPC URL", async () => {
	const { BlockNotFoundError, createPublicClient, http } = await import("viem");
	expect(errorLine(new BlockNotFoundError({ blockNumber: 123n }))).toBe('Block at number "123" could not be found.');

	// a provider that answers 429: viem's full message names the URL, key included
	const server = Bun.serve({ port: 0, fetch: () => new Response("Too Many Requests", { status: 429 }) });
	try {
		const client = createPublicClient({ transport: http(`${server.url}v3/SECRET_KEY`, { retryCount: 0 }) });
		const err = await client.getBlockNumber().catch((e) => e);
		expect(err.message).toContain("SECRET_KEY");
		const line = errorLine(err);
		expect(line).not.toContain("SECRET_KEY");
		expect(line).not.toContain("\n");
		expect(line).toContain("HTTP request failed");
	} finally {
		server.stop(true);
	}
});

test("errorLine: other errors give their first line and where in the packages they were thrown", () => {
	const err = new TypeError("undefined is not an object (evaluating 'logs.map')\nmore");
	err.stack = [
		"TypeError: undefined is not an object (evaluating 'logs.map')",
		"    at getLogs (/x/node_modules/viem/_esm/actions/public/getLogs.js:72:27)",
		"    at async getChanges (/x/packages/registrar-indexer/src/l2.ts:89:40)",
		"    at async tick (/x/packages/registrar-indexer/src/indexer.ts:132:14)",
	].join("\n");
	expect(errorLine(err)).toBe(
		"TypeError: undefined is not an object (evaluating 'logs.map') (getChanges, packages/registrar-indexer/src/l2.ts:89)",
	);
	expect(errorLine("plain")).toBe("plain");
});
