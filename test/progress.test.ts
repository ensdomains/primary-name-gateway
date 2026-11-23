// Progress lines for long syncs: position, percent, rate and time left, at most one per interval.

import { expect, test } from "bun:test";
import { duration, Progress } from "../packages/registrar-indexer/src/progress.js";

test("durations", () => {
	expect([0.4, 59, 61, 3599, 3600, 7260, 90000].map(duration)).toEqual([
		"0s",
		"59s",
		"1m",
		"1h00m", // 59m59s rounds up
		"1h00m",
		"2h01m",
		"25h00m",
	]);
});

test("progress lines are throttled and say where it is", async () => {
	const lines: string[] = [];
	const p = new Progress("syncing events: L2 block", 1000, 3000, (s) => lines.push(String(s)), "blocks", 20);
	p.update(1500); // too soon
	expect(lines).toEqual([]);
	await Bun.sleep(25);
	p.update(2000, "7 changes");
	p.update(2100); // too soon again
	p.update(3000); // done: the caller reports the end
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(
		/^syncing events: L2 block 2,000 \/ 3,000 \(50\.0%\), 7 changes, [\d,]+ blocks\/s, ~\d+s left$/,
	);
});

test("a step that doesn't move says how long it has waited", async () => {
	const lines: string[] = [];
	const p = new Progress("syncing", 0, 100, (s) => lines.push(String(s)), "blocks", 20);
	p.update(10);
	const stop = p.heartbeat(() => p.update(10));
	await Bun.sleep(75);
	stop();
	expect(lines.length).toBeGreaterThan(1);
	expect(lines.at(-1)).toMatch(/^syncing 10 \/ 100 \(10\.0%\).*, waiting 0s$/);
});

test("no rate or time left before it has moved", () => {
	const lines: string[] = [];
	new Progress("syncing", 0, 100, (s) => lines.push(String(s)), "blocks", 0).update(0, "0 changes");
	expect(lines).toEqual(["syncing 0 / 100 (0.0%), 0 changes, waiting 0s"]);
});
