# RPC providers

The indexer depends on three kinds of RPC call. Each provider limits them differently, so each kind is routed to the provider that does it best. This page lists what we've hit, what the code does about it, and every environment override.

The limits below are what we observed with our own keys on 2026-11-22 (drpc paid key, Alchemy free plan, Infura key), along with the exact error each provider returns. Plans differ, so check your provider's docs for yours.

## What the indexer asks for

| purpose | calls | used for |
|---|---|---|
| `logs` | `eth_getLogs` over wide block ranges | replaying the registrar's events from its creation block ([registrar.md](registrar.md)) |
| `proof` | `eth_getProof` (OP Stack), `linea_getProof` (Linea) at a commit's L2 block | the registrar's account proof, captured when a commit is seen. On OP / Base the first start looks back 6–8 days, which needs **archive** state. |
| `default` | everything else: blocks, `eth_call`, L1 contract reads, L1 `getLogs` for Linea finalizations | |

`createClient(chain, purpose)` ([chains.ts](../packages/shared/src/chains.ts)) picks the URL. Clients for `logs` retry once with a 30s timeout, because an oversized range fails the same way every time and the caller should shrink it instead. The others retry 5 times with a 60s timeout.

## Choosing a URL

For a chain with id `<id>` and a purpose, the first one that's set wins:

1. `PROOF_RPC_URL_<id>`: `proof` calls only
2. `RPC_URL_<id>`: every purpose
3. a provider key, in this order per purpose:

   | purpose | order |
   |---|---|
   | `default` | drpc, Infura, Alchemy |
   | `logs` | drpc, Infura, Alchemy |
   | `proof` | Alchemy, drpc, Infura |

4. the chain's public RPC, where there is one (none for Base)

Chain ids: Ethereum `1`, OP Mainnet `10`, Base `8453`, Linea `59144`. Logs show URLs through `redactURL()`, which hides the key for all three providers.

## Providers

| | drpc (`DRPC_KEY`) | Alchemy (`ALCHEMY_KEY`) | Infura (`INFURA_KEY`) |
|---|---|---|---|
| URL | `https://lb.drpc.live/<slug>/<key>` | `https://<slug>.g.alchemy.com/v2/<key>` | `https://<slug>.infura.io/v3/<key>` |
| `getLogs` range | wide (we use up to 500,000 blocks) | **10 blocks** on the free plan | **10,000 blocks** |
| `getLogs` results | at most **20,000** per request; large responses also fail | — | — |
| archive `eth_getProof` | only ~100k blocks back on OP ("Can't route") | yes | only within **10,000 blocks** of the head |
| `linea_getProof` | yes | yes | yes |
| docs | [rate limiting](https://drpc.org/docs/howitworks/ratelimiting), [archive nodes](https://drpc.org/docs/howitworks/archive-nodes), [`eth_getLogs`](https://drpc.org/docs/base-api/eventlogs/eth_getLogs), [plans](https://drpc.org/docs/pricing/plans) | [`eth_getLogs`](https://www.alchemy.com/docs/reference/eth-getlogs), [compute units](https://www.alchemy.com/docs/reference/compute-unit-costs), [pricing](https://www.alchemy.com/pricing) | [docs](https://docs.infura.io/), [pricing](https://www.infura.io/pricing) |

So with all three keys: **drpc** serves logs and general calls, **Alchemy** serves proofs (it's the only one with archive state), and **Infura** is the fallback for logs and general calls, and for proofs near the head.

Public RPCs:

| chain | public RPC | notes |
|---|---|---|
| Ethereum | `https://ethereum-rpc.publicnode.com` | answers 403 to archive requests |
| OP Mainnet | `https://mainnet.optimism.io` | |
| Base | none | `mainnet.base.org` rate limits `eth_getLogs` |
| Linea | `https://rpc.linea.build` | serves `linea_getProof` |

## Problems we've hit

| symptom (error text) | provider | cause | what the code does |
|---|---|---|---|
| `HTTP response body exceeded the size limit.` / `query exceeds max results 20000, retry with the range A-B` (viem may show this as `Invalid parameters were provided to the RPC method.`) | drpc | too many events in the range. Base's registrar has stretches of ~100 events per block (the migration's `batchSetName`) | the log reader halves the range, down to a single block, and doubles it again once results are sparse (under 100 logs) |
| `range N exceeds limit of 10000` | Infura | a fixed range limit | the reader parses "limit of N" and never asks for more than N blocks again |
| `Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range` | Alchemy | free plan | Alchemy is last in line for logs; avoid it for logs unless the plan allows wider ranges |
| `Can't route your request to suitable provider` | drpc | proof too far back (> ~100k blocks) | proofs go to Alchemy first |
| `eth_getProof is limited to a 10,000 range` | Infura | no archive state | proofs go to Alchemy first |
| `BLOCK_MISSING_IN_CHAIN - block is missing` | any (`linea_getProof`) | Shomei only keeps the last ~10–20 finalizations (about a day), and only at finalized blocks | the indexer fetches the proof when it sees the finalization, retries, then skips it ([linea.md](linea.md)) |
| `App is inactive. Please create a new app or contact support` | Alchemy | the key's app is disabled in the dashboard | none: use another key |
| 403 on archive calls | publicnode | public endpoint, no archive | set a key |

Two rules keep provider trouble from losing data:

- **A failed event sync is not the commit's fault.** It throws `SyncError`, which is retried on the next tick without using up the commit's attempts (`INDEXER_MAX_ATTEMPTS`). Before this, a provider problem could get valid Base games skipped.
- **Proofs are captured once, when the commit is seen.** If the proof provider can't serve that block (not archive, or Shomei has forgotten it), the commit can't be indexed later. Point `PROOF_RPC_URL_<id>` at an archive endpoint for OP / Base lookbacks, and keep the Linea indexer running.

## Environment

RPC:

| variable | |
|---|---|
| `DRPC_KEY`, `ALCHEMY_KEY`, `INFURA_KEY` | provider keys (any subset) |
| `RPC_URL_<id>` | explicit URL for a chain, every purpose |
| `PROOF_RPC_URL_<id>` | explicit URL for a chain's proofs |

Indexer (`bun run indexer`, `indexer:base`, `indexer:linea`, `indexer:base-inbox`):

| variable | default | |
|---|---|---|
| `INDEXER_CHAIN` | `optimism` | `optimism`, `base`, `linea`, or `base-inbox` / `optimism-inbox` ([op-batch-inbox.md](op-batch-inbox.md)) |
| `INDEXER_PORT` | `8100` | the `:base` / `:linea` scripts use 8102 / 8101 |
| `INDEXER_DB` | `data/<chain>.sqlite` | |
| `INDEXER_POLL_MS` | `30000` | |
| `INDEXER_MAX_ATTEMPTS` | `5` | failures before a commit is skipped (sync failures don't count) |
| `INDEXER_LOOKBACK_SEC` | game finality + 1 day | OP / Base: how far back the first start looks |
| `INDEXER_MIN_FINAL_AGE_SEC` | game finality − 1 day | OP / Base: start checking validity at this age |
| `INDEXER_MIN_AGE_SEC` | `0` | OP / Base: accept unchallenged games this old; must equal the verifier's `minAgeSec` ([optimism.md](optimism.md#early-acceptance-minagesec)) |
| `INDEXER_LOOKBACK_L1_BLOCKS` | `3600` | Linea: L1 blocks to scan on first start |
| `INDEXER_INBOX_INTERVAL_SEC` | `600` | inbox: at most one commit per this much L1 time |
| `INDEXER_INBOX_SCAN_BLOCKS` | `64` | inbox: L1 blocks to look back for a channel start |
| `INDEXER_INBOX_MAX_BLOCK_LAG` | `7200` | inbox: commits older than this many L1 blocks become invalid (below the verifier's `maxBlockLag`) |
| `BEACON_URL` | `https://ethereum-beacon-api.publicnode.com` | inbox: beacon API for blobs |
| `KZG_TRUSTED_SETUP` | `data/kzg/trusted_setup.txt` | inbox: downloaded there if missing |
| `INDEXER_FLUSH_CHANGES` | `50000` | OP / Base: changes applied in memory before the trie rows are written ([optimism.md](optimism.md#trie-rows)) |
| `INDEXER_CACHE_MB` | `64` | SQLite page cache |

Gateway (`bun run gateway`, `gateway:base`, `gateway:linea`, `gateway:base-inbox`):

| variable | default | |
|---|---|---|
| `GATEWAY_CHAIN` | `optimism` | sets the registrar layout and default DB name |
| `INDEXER_URL` | `http://localhost:8100` | |
| `GATEWAY_PORT` | `8200` | |
| `GATEWAY_DB` | `data/gateway-<chain>.sqlite` | |
| `GATEWAY_KEEP` | `2` | valid commits held |
| `GATEWAY_MARGIN_SEC` | `120` | serve a commit once it has been valid this long |
| `GATEWAY_POLL_MS` | `30000` | |

Fork test (`bun run test:fork`, [op-batch-inbox.md](op-batch-inbox.md)): needs an archive L1 RPC (`ALCHEMY_KEY`, or `PROOF_RPC_URL_1` / `RPC_URL_1`).

Mainnet test (`bun run test:mainnet`):

| variable | default | |
|---|---|---|
| `INDEXER_URL` | `http://localhost:8100` | the running indexer to test against |
| `INDEXER_MIN_AGE_SEC` | `0` | `minAgeSec` for the deployed OP / Base verifier |
| `MAINNET_SAMPLE` | `500` | verify every name up to this many, otherwise a sample (all long names plus random ones) |
