// Timestamped log lines at four levels: plain information, ok (progress: a valid commit, caught up,
// ready), warn (waiting, retrying, starting over) and error (failures, invalid commits, work given
// up). On a terminal the timestamp is dim and ok / warn / error lines are green / yellow / red; plain
// when piped (production logs) or with NO_COLOR, and FORCE_COLOR forces color. Runtime-agnostic:
// `process` is only read when the color isn't given.

export type Log = {
	(...args: unknown[]): void;
	ok(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};

type Env = Record<string, string | undefined>;
const proc = (globalThis as { process?: { stdout?: { isTTY?: boolean }; env?: Env } }).process;

export function useColor(stream: { isTTY?: boolean } | undefined = proc?.stdout, env: Env = proc?.env ?? {}): boolean {
	if (env.NO_COLOR) return false;
	if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
	return !!stream?.isTTY;
}

type Style = (s: string) => string;

// ANSI styles for a terminal; without color each returns its text unchanged
export function styles(color = useColor()): Record<"bold" | "dim" | "red" | "green" | "yellow", Style> {
	const paint =
		(code: number): Style =>
		(s) =>
			color ? `\x1b[${code}m${s}\x1b[0m` : s;
	return { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33) };
}

export function createLog(color = useColor(), write: (...args: unknown[]) => void = console.log): Log {
	const { dim, green, yellow, red } = styles(color);
	const line =
		(style?: Style) =>
		(...args: unknown[]) => {
			const [first, ...rest] = args;
			write(dim(new Date().toISOString()), style && typeof first === "string" ? style(first) : first, ...rest);
		};
	return Object.assign(line(), { ok: line(green), warn: line(yellow), error: line(red) });
}

// a Log from a plain function (every level calls it), or a silent one
export function toLog(fn?: ((...args: unknown[]) => void) | Log): Log {
	if (fn && "ok" in fn) return fn;
	const f = (...args: unknown[]) => fn?.(...args);
	return Object.assign(f, { ok: f, warn: f, error: f });
}

// One line for a failure that is retried anyway (a tick, a sync), not a source excerpt and a stack:
// viem's short message and details (never its full message, whose "URL:" line can carry an RPC key),
// else the error's first line and the first frame in this repo's packages.
export function errorLine(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const clip = (s: string) => {
		const first = s.split("\n")[0];
		return first.length > 200 ? `${first.slice(0, 200)}…` : first;
	};
	const { shortMessage, details } = err as { shortMessage?: string; details?: string };
	if (shortMessage) return details && details !== shortMessage ? `${shortMessage} ${clip(details)}` : shortMessage;
	const at = err.stack?.match(/at (?:async )?(\S+) \(.*?\/(packages\/[^:)]+):(\d+)/);
	return `${err.name}: ${clip(err.message)}${at ? ` (${at[1]}, ${at[2]}:${at[3]})` : ""}`;
}
