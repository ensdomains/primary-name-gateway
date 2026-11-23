// The indexer gzips JSON responses when the client accepts it (the offline e2es check that the
// gateway's fetch reads them).

import { expect, test } from "bun:test";
import { json } from "../packages/registrar-indexer/src/server.js";

const request = (encoding?: string) =>
	new Request("http://indexer/snapshot", { headers: encoding ? { "accept-encoding": encoding } : {} });
const rows = Array.from({ length: 2000 }, (_, i) => ({ path: i.toString(16), node: `0x${"ab".repeat(40)}` }));

test("large responses are gzipped when accepted", async () => {
	const res = json(request("gzip, deflate, br"), rows);
	expect(res.headers.get("content-encoding")).toBe("gzip");
	expect(res.headers.get("vary")).toBe("accept-encoding");
	const body = new Uint8Array(await res.arrayBuffer());
	expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(body)))).toEqual(rows);
	expect(body.length).toBeLessThan(JSON.stringify(rows).length / 4);
});

test("small responses, and clients that don't accept gzip, get plain JSON", async () => {
	for (const res of [json(request("gzip"), { ok: true }), json(request(), rows), json(request("br"), rows)]) {
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(await res.json()).toBeTruthy();
	}
});
