// Progress lines for long work (event sync, trie rebuild): where it is in a range, how fast, and
// roughly how long is left. At most one line per `everyMs`; `heartbeat` keeps them coming while a
// slow step (one eth_getLogs) hasn't moved it.
export class Progress {
	private readonly start = Date.now();
	private last = this.start;
	private at: number;
	private movedAt = this.start;

	constructor(
		private readonly label: string,
		private readonly from: number,
		private readonly to: number,
		private readonly log: (...args: unknown[]) => void,
		private readonly unit = "blocks",
		private readonly everyMs = 10_000,
	) {
		this.at = from;
	}

	update(at: number, detail?: string) {
		const now = Date.now();
		if (at !== this.at) {
			this.at = at;
			this.movedAt = now;
		}
		if (now - this.last < this.everyMs || at >= this.to) return;
		this.last = now;
		const still = now - this.movedAt >= this.everyMs ? `, waiting ${duration((now - this.movedAt) / 1000)}` : "";
		const done = at - this.from;
		const total = this.to - this.from;
		const rate = done / ((now - this.start) / 1000);
		const speed = rate > 0 ? `, ${n(Math.round(rate))} ${this.unit}/s, ~${duration((this.to - at) / rate)} left` : "";
		this.log(
			`${this.label} ${n(at)} / ${n(this.to)} (${((100 * done) / total).toFixed(1)}%)${detail ? `, ${detail}` : ""}${speed}${still}`,
		);
	}

	// calls `update` every `everyMs` until stopped
	heartbeat(update: () => void): () => void {
		const timer = setInterval(update, this.everyMs);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	// how long since it started
	get elapsed(): string {
		return duration((Date.now() - this.start) / 1000);
	}
}

export const n = (x: number) => x.toLocaleString("en-US");

export function duration(sec: number): string {
	if (sec < 60) return `${Math.round(sec)}s`;
	const m = Math.round(sec / 60);
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
