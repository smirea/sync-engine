## Why

Browser apps had no database or sync client; this was the piece PowerSync provided. `sync-engine/client-web` runs sqlite-wasm on OPFS inside a worker and serves every tab of the origin from one connection.

## What changed

- `sync-engine/client-web/worker` exports `startSyncWorker({ schema, endpoint, filename, token? })` for the app's worker script. The holder of the Web Lock `sync-engine:<filename>` opens the `opfs-sahpool` database, runs `createSyncClient`, and serves the other tabs' workers over a `BroadcastChannel`.
- `sync-engine/client-web` exports `openSyncDatabase({ worker })`, a `WebDatabase` with `exec`, `batch`, `sync`, `status`, `setToken`, `onChange`, `close`, and `drizzleSyncDatabase(db)` over `drizzle-orm/sqlite-proxy`.
- `bun-server` answers the CORS preflight for `/sync` so a page on another port can call it.

## Scope

- No SharedWorker. Chromium exposes OPFS sync access handles only to dedicated workers and has no `Worker` constructor inside a SharedWorker, so the decided shape could not work there. Tabs elect a host with Web Locks instead, and the lock queue is the failover. The decision doc records the measurements.
- Explicit transactions are refused with a typed `explicit-transaction` error; `batch()` and drizzle's `db.batch()` are the transactional form. Drizzle's `db.transaction()` gets that error.
- Known holes, all recorded in `docs/decisions/sync.md`: a write the old host executed but never answered is resent after a failover and can fail on its primary key; a worker still loading its script misses one change broadcast; the `already-open` error is reachable only without Web Locks and is not exercised by the test; the token model (`undefined` no auth, string, `null` waits) is new.

## Blast Radius

New package plus one dev-server header change. `bun run test` now ignores `packages/client-web`, and a new `web` CI job runs it when `packages/client-web/` or `packages/client/` changed. The Playwright install on ubuntu runs for the first time in this PR.

## Verification

- `bun run test:web` in chromium-1248 and webkit-2370 on macOS: two tabs, a Bun peer, reload keeps rows and client id, host failover, `BEGIN` refused, `batch` lands two rows with one `onChange`, a lone tab syncs. 36 assertions, 2.9 s. Write-to-other-tab latency over five runs: chromium 3.8 to 7.9 ms, webkit 1.0 to 3.0 ms. Close-to-next-write failover 35 to 46 ms in both.
- WebKit OPFS throws `UnknownError` in a Playwright ephemeral context; the test uses persistent contexts for both browsers.
- `bun run lint:ci`, `bun check`, `bun run build`, `bun run test` (102 pass).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
