import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

// One indexer per database (base and base-inbox share one): `<db>.lock` holds the pid of the indexer
// using it. A lock left by a process that's gone (killed, crashed) is taken over. Returns the release.
export function lockDatabase(dbPath: string): () => void {
	const path = `${dbPath}.lock`;
	const pid = String(process.pid);
	for (let attempt = 0; ; attempt++) {
		// written aside and linked into place, so the lock never exists without its pid
		const tmp = `${path}.${pid}`;
		writeFileSync(tmp, pid);
		try {
			linkSync(tmp, path);
			return () => {
				try {
					if (readFileSync(path, "utf8") === pid) unlinkSync(path);
				} catch {}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt) throw err;
		} finally {
			unlinkSync(tmp);
		}
		const holder = Number(readFileSync(path, "utf8"));
		if (isRunning(holder)) throw new Error(`${dbPath} is in use by another indexer (pid ${holder}): stop it first`);
		unlinkSync(path); // stale
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"; // running, as another user
	}
}
