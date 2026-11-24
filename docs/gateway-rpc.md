# Gateway JSON-RPC and status

The gateway's HTTP side ([index.ts](../packages/registrar-gateway/src/index.ts), `createGatewayHandler`): `GET /status`, JSON-RPC at `/rpc`, and CCIP-Read on every other path.

## Status

`GET /status`, like the indexer's:

```json
{
  "chain": "arbitrum", "kind": "arbitrum", "l1ChainId": 1, "l2ChainId": 42161,
  "registrar": "0x0000000000D8e504002cC26E3Ec46D81971C1664", "layout": { "namesSlot": 0 }, "minAgeL1Blocks": 1800,
  "indexerURL": "http://localhost:8104",
  "served": { "id": 264804150022, "l2Block": 526908163, "validAt": 1795490521 },
  "held": [{ "id": 264801160406, "l2Block": 526895226, "validAt": 1795487068 }, { "id": 264804150022, "l2Block": 526908163, "validAt": 1795490521 }],
  "lastSync": { "at": 1795493534, "ms": 6 },
  "startedAt": 1795493534,
  "stats": { "snapshots": 0, "patches": 0, "rows": 0 },
  "keepCommits": 2, "serveDelaySec": 0
}
```

- `chain` to `minAgeL1Blocks`: the deployment and the early acceptance its commits assume (`minAgeSec` on OP Stack chains), from the indexer's `/status` (absent until the indexer has answered once); `bun run prove` deploys its verifier with it; `indexerURL`: where it syncs from.
- `served`: the commit CCIP-Read proofs come from: the newest held one that has been valid for `serveDelaySec`, else the oldest held one (absent before the first commit); `held`: the commits in the store.
- Until the gateway holds a commit (its first snapshot, or a new one after starting over), CCIP-Read answers HTTP 503 `no commit yet: the gateway is syncing`, logged on one line, and JSON-RPC answers `-32000`.
- `lastSync`: when the last sync with the indexer ended and how long it took, with `error` if it failed: a gateway that can't reach its indexer keeps serving its held commits, and this is where that shows.
- `stats`: snapshots, patches and rows loaded since `startedAt` (zero above: a restart that resumed from its store).

## JSON-RPC

The gateway answers JSON-RPC at `/rpc` for the registrar's storage, at the blocks of the commits it holds. It answers from its rows as an L2 node would, so standard tools work against it (`cast`, viem's `getProof`, any prover that calls `eth_getProof`) without an archive node. ([rpc.ts](../packages/registrar-gateway/src/rpc.ts))

| method | answer |
|---|---|
| `eth_getProof(registrar, keys, block)` | the account proof stored with the commit (its last node gives `balance`, `nonce`, `codeHash`), `storageHash`, and a proof per key from the rows. Merkle-Patricia commits only: Linea's state is a sparse Merkle trie (`linea_getProof`, not served). |
| `eth_getStorageAt(registrar, slot, block)` | the slot's value from the rows (any commit kind) |
| `eth_chainId` | the L2's |
| `eth_blockNumber` | the L2 block of the commit the gateway serves |

Rules:

- **Blocks:** only the L2 blocks of the held commits (`GATEWAY_KEEP_COMMITS`, 2 by default). `latest`, `safe`, `finalized` and `pending` mean the commit the gateway serves to CCIP-Read (the newest valid, after `GATEWAY_SERVE_DELAY_SEC`). Any other block is an error that lists the held ones: answering for a nearby block would mislead. Blocks by hash aren't served.
- **Accounts:** only the registrar. Another address is an error, never an empty proof (which would claim the account doesn't exist).
- Errors: `-32000` for a block that isn't held, another account, or no commit yet; `-32602` for bad parameters or a block by hash; `-32601` for an unknown method, or `eth_getProof` on Linea; `-32600` / `-32700` for a malformed request or batch. A missing block parameter means `latest`.
- JSON-RPC 2.0, batches included, POST only, with CORS (OPTIONS answers preflight).
- Like proofs for CCIP-Read, answers only copy rows: the gateway still hashes nothing but slot keys.

## Checked (2026-11-24)

Against Alchemy's archive `eth_getProof` at the same blocks, from a gateway's rows: identical `storageHash`, `accountProof`, `balance`, `nonce`, `codeHash`, values and storage proofs (one field at a time, through viem's `getProof` and `getStorageAt`), on

- Arbitrum (316 rows): a name (`lillithh.eth`, 4-node proof) and an unset address, at both held blocks;
- Base (70,000 chunk rows, a deep trie with inline nodes): a name (7 nodes), an unset address, and the owner slot.

Building an answer takes 0.4 ms (Arbitrum) to 2.7 ms (Base). `test/offline.test.ts` checks the answers against the fake L2's own trie (`EthStorage.getProof`) and the error cases.

```bash
cast proof --rpc-url http://localhost:8204/rpc 0x0000000000D8e504002cC26E3Ec46D81971C1664 $(cast index address 0x629c26b50823872E561a721c0C2d5113edDa4DD9 0)
```

```bash
cast storage --rpc-url http://localhost:8204/rpc 0x0000000000D8e504002cC26E3Ec46D81971C1664 $(cast index address 0x629c26b50823872E561a721c0C2d5113edDa4DD9 0)
```

## Uses

- **No archive node for the registrar:** a prover that calls `eth_getProof` on an L2 RPC (for example unruggable-gateways' `EthProver`) can use this endpoint for the registrar's account, with its other calls (block headers, other accounts) going to a normal node.
- **Checking a gateway:** compare its answers with a provider's, as above.
- The indexer could do more: it keeps the tries of more commits (`retainValid`, 24) for `eth_getProof`, and its change log has every slot's value at every synced block for `eth_getStorageAt`. It isn't public-facing, so that's left for debugging.
