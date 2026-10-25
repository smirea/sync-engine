## Why

The engine at `f4ffc1f` grew tombstones and `_log` forever and sent a first download as one response. `7e25a98` speaks protocol 2, which pages a snapshot, resumes it after a crash, and compacts tombstones behind a 30 day horizon. This PR moves the server and the iOS app to that pin.

## What changed

- `package.json`, `bun.lock` and `Package.resolved` pin sync-engine `7e25a98`; `api.test.ts` drives `handle` with protocol 2.
- `parseConfig` takes `SYNC_PAGE_SIZE`, `SYNC_RETENTION_MS` and `SYNC_COMPACT_EVERY_MS` in development only and refuses them in production, so the Bun server and `wrangler dev` can show paging and compaction over a few rows. Both hosts pass `config.space` to the engine.
- The More tab shows "Downloading… N rows" while a paged first download is in progress (`LocalStore.snapshotRows`).

## Scope

Production keeps the engine defaults (1000 rows per page, 30 days of retention, hourly compaction). No new routes. The engine still accepts protocol 1 from a phone that has not updated; removing it is an engine change for after the owner's phone runs this build.

## Blast radius

Every sync from a device that runs this build. A device on the old build keeps syncing over protocol 1 against the new server. `SYNC_*` set on the Worker makes it fail every request at startup by design, the same as a missing `OWNER_TOKEN`.

## Verification

- On the rebased tree: `bun test shared server` 19 pass, Xcode suite 214 pass, `wrangler deploy --dry-run` ok. The device run below was made before the rebase onto the Sentry merge; the rebase changed server config and tests only, so the production check after deploy is the post-rebase device proof.
- Three simulators against the local Bun server with page size 3: a fresh install paged 633 rows in 211 pages and converged 1.4 s after its database appeared; a Weight Unit change on A reached B in 122 ms; a change made on B while the server was down reached A 915 ms after restart with a 45 s outage and 9.9 s with a 60 s outage (the old build took 67 s); with retention 0 a token revoked on A left B 121 ms later and the server then held no tombstone and an empty `_log`; a third client installed after that converged and showed the download row. Script, logs and screenshots: `sync-engine/.audit/engine-v2/`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
