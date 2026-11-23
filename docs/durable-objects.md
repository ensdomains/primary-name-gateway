# Running the gateway in a Durable Object

The gateway library is written so it can run inside a Cloudflare Durable Object. That gives a CCIP-Read endpoint with no server to operate. The indexer stays a normal process. This page explains what a Durable Object is, how the gateway maps onto one, and the limits that matter. Nothing here is deployed yet; the code below is a sketch.

Cloudflare facts below are from its docs as of 2026-11 (linked inline). Check the [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) pages for current numbers.

## What a Durable Object is

A Durable Object is a Worker with its own storage ([what are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)):

- **One instance per name.** Each object has a globally unique name or id, and at most one instance is active at a time. A Worker gets a stub with `env.BINDING.getByName(name)`, and every request for that name reaches the same object, wherever it was sent from.
- **Single-threaded.** An object handles its requests one at a time, with cooperative multitasking at `await` points. Input and output gates keep storage consistent across those points.
- **Placed near its first request,** and moved between machines by Cloudflare. A [location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/) can choose the region.
- **Private SQLite storage** ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)):
  - `ctx.storage.sql.exec(query, ...bindings)` runs SQL and returns a cursor (`toArray()`, `one()`, `raw()`, `rowsRead`, `rowsWritten`). It runs synchronously, with no `await`.
  - `ctx.storage.transactionSync(fn)` runs `fn` as a transaction, rolled back if it throws.
  - Up to 10 GB per object.
- **Alarms** ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)):
  - Each object can have one alarm. `ctx.storage.setAlarm(time)` schedules it, and the runtime calls the object's `alarm()` method at least once.
  - If `alarm()` throws, it's retried with exponential backoff (from 2 seconds, up to 6 times) and then given up.
- **Memory doesn't last** ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)):
  - An idle object hibernates after about 10 seconds, or is evicted after 70–140 seconds. Its in-memory state is lost and the constructor runs again on the next request.
  - Anything that has to survive belongs in storage.

## How the gateway fits

One object per served chain, for example named `base`, holds that chain's gateway:

| gateway part | in the Durable Object |
|---|---|
| `NodeStore` (versioned trie rows) | `SqlNodeStore` over `ctx.storage.sql` |
| `sync()` (poll the indexer, apply patches) | the `alarm()` handler, rescheduled every poll interval |
| CCIP-Read requests (`proveName`) | the object's `fetch()`, served by `createFetchHandler(createEZCCIP(gateway))` from [`@adraffy/ezccip`](https://github.com/adraffy/ezccip.js) |
| gateway state (held commits, the store's head, a snapshot in progress) | the `gateway_meta` table in the same SQLite database |
| the indexer | a normal server; the object reaches it over HTTP (`indexerURL`) |

The design already makes the gateway a good fit:

- **`NodeStore` is synchronous** (an invariant in [AGENTS.md](../AGENTS.md)), like the Durable Object SQL API. `SqlNodeStore` only needs an `SqlAdapter`:

  ```ts
  const sql: SqlAdapter = {
  	exec: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray(),
  	transaction: (fn) => ctx.storage.transactionSync(fn),
  };
  ```

  `put` runs in one transaction, so each patch or snapshot page is applied whole or not at all.
- **No in-memory state.** The gateway keeps everything in its store, including held commits, the head, and a snapshot cursor. Eviction and hibernation cost nothing: a new instance reads the same SQLite database and carries on with patches.
- **Snapshots are resumable.** The cursor is saved after each page, so an alarm that's cut short resumes on the next run.
- **Requests are cheap.** A proof copies a few dozen rows along a slot's key path, and the gateway hashes nothing but slot keys and one root per loaded commit. That fits the single-threaded model easily.
- **Steady-state syncs are cheap.** Apart from the first snapshot, a sync is one `/commits` request and, when a commit arrives, a patch of tens to hundreds of rows. `SqlNodeStore.prune` is incremental: `put` records the paths it writes in `trie_dirty`, and a prune only looks at those. Only the first prune after a snapshot is a full pass. On a store the size of Base's (5M rows), a prune takes under a millisecond after a patch and nothing when there's nothing new. A full pass on every sync took about 1.6 s.
- **`src/index.ts` is runtime-agnostic:** no bun or node imports. Bun-only code lives in `src/main.ts` and `src/sqlite.ts`.

## Sketch

A Worker routes requests to the chain's object, and the object syncs on an alarm. This is untested; it uses the APIs as Cloudflare documents them:

```ts
import { DurableObject } from "cloudflare:workers";
import { createFetchHandler } from "@adraffy/ezccip";
import { DEPLOYMENTS } from "@primary-name-gateway/shared";
import { createEZCCIP, RegistrarGateway, SqlNodeStore } from "@primary-name-gateway/registrar-gateway";

const POLL_MS = 30_000;

export class Gateway extends DurableObject<Env> {
	gateway: RegistrarGateway;
	handler: (request: Request) => Promise<Response>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const store = new SqlNodeStore({
			exec: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray(),
			transaction: (fn) => ctx.storage.transactionSync(fn),
		});
		this.gateway = new RegistrarGateway(store, {
			indexerURL: env.INDEXER_URL,
			keep: 2,
			marginSec: 120,
			layout: DEPLOYMENTS[env.CHAIN].layout,
		});
		this.handler = createFetchHandler(createEZCCIP(this.gateway));
		// start syncing on first use
		ctx.blockConcurrencyWhile(async () => {
			if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
		});
	}

	fetch(request: Request) {
		return this.handler(request);
	}

	async alarm() {
		try {
			await this.gateway.sync();
		} catch (err) {
			console.error("sync failed:", err); // retried at the next poll, not by the alarm's own retries
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		}
	}
}

export default {
	fetch: (request: Request, env: Env) => env.GATEWAY.getByName(env.CHAIN).fetch(request),
};
```

Wrangler config (see [get started](https://developers.cloudflare.com/durable-objects/get-started/)): declare `Gateway` as a SQLite-backed Durable Object class, bind it as `GATEWAY`, and set `CHAIN` and `INDEXER_URL` as vars.

## Limits and costs

| limit (Cloudflare docs) | what it means here |
|---|---|
| 30 s CPU per invocation by default, configurable up to 5 minutes (`limits.cpu_ms`); alarm handlers have 15 minutes of wall time | A steady-state sync takes milliseconds. A first snapshot does not: Base's is 102 pages (about 70,000 chunk rows, 393 MB gzipped); a bun gateway loads it in about 30 s. That spans many alarms (see Open). |
| 10 GB storage per object | Base's chunks take about 0.6 GB in SQLite, and the gateway holds one copy plus the chunks that changed since its oldest held commit. |
| rows written: Free 100,000/day; Paid 50 million/month included, then $1.00/million | Every trie row put or pruned is a row written, and after the first prune each patch row is also recorded once in `trie_dirty`. Rows are chunks (see [optimism.md](optimism.md#trie-rows)): a Base snapshot is about 70,000 rows, which fits a day of the Free plan. After that, a patch is a few hundred rows per commit. Linea's and OP Mainnet's registrars are tiny. |
| rows read: Paid 25 billion/month included | A proof reads 5 rows per slot (4 trunk nodes and 1 limb). |
| about 1,000 requests per second per object (soft) | One object serves one chain's requests one at a time. To serve more, run more objects (each a full copy that syncs on its own), for example one per region. |
| SQL: 100 bound parameters, 100 KB per statement, 8 MB per row | `SqlNodeStore` binds at most 3 parameters per statement and stores single trie nodes (at most a few hundred bytes). |

## What stays outside

The indexer doesn't fit a Durable Object, and doesn't need to:

- It replays millions of events.
- It keeps its own SQLite trie (`bun:sqlite`).
- It needs archive RPC.
- For the batch inbox, it computes KZG proofs, at about 0.25 seconds each.

It runs as a normal process. Gateways only read `/commits`, `/snapshot` and `/patch` from it, and they check every commit they load against its storage root.

## Open

- **Bounded sync work.** `sync()` loads a whole snapshot in one call. In a Durable Object, each alarm should do a bounded amount, such as a fixed number of pages, and leave the rest to the next alarm. Today that relies on the saved cursor surviving an invocation that runs out of CPU. A `maxPages` option on `sync()` would make it explicit.
- **Requests during the first snapshot.** Until a commit is held, `proveName` has nothing to prove from and the request fails. Serving can start once the first snapshot completes.
- **One object per chain.** Read scaling means more objects, each syncing its own copy from the indexer.
