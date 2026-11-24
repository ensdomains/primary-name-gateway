// Timestamped log lines. On a terminal the timestamp is dim and a line is colored by what it reports:
// red for failures, yellow for waiting and retries, green for valid commits and progress. Plain when
// piped (production logs), with NO_COLOR, or forced with FORCE_COLOR.

const RED = 31;
const GREEN = 32;
const YELLOW = 33;

export function useColor(stream: { isTTY?: boolean } = process.stdout, env = process.env): boolean {
	if (env.NO_COLOR) return false;
	if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
	return !!stream.isTTY;
}

export function lineColor(message: string): number | undefined {
	if (/failed|\binvalid\b|mismatch|skipped|refused/i.test(message)) return RED;
	if (/waiting|retrying|rate limited|trying an earlier|none with a final/i.test(message)) return YELLOW;
	if (/: valid\b|\(valid\)|caught up|listening on|restored|new database/.test(message)) return GREEN;
}

export function createLog(color = useColor()): (...args: unknown[]) => void {
	const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
	return (...args) => {
		const time = paint(2, new Date().toISOString());
		const [first, ...rest] = args;
		if (typeof first !== "string") return console.log(time, ...args);
		const code = lineColor(first);
		console.log(time, code ? paint(code, first) : first, ...rest);
	};
}
