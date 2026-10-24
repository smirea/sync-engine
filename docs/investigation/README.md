# Investigation: replacing PowerSync with our own sync engine

Written 2026-10-24. The rendered report with diagrams is [`report.html`](report.html). This file holds the findings and the reasoning in text so agents can read them.

## What the apps run today

Both apps share one scaffold: `shared/` Drizzle `pg-core` schema, a Cloudflare Worker that serves the SPA and `/api/*`, Supabase Postgres through Hyperdrive, PowerSync Cloud replicating a `powersync` publication, and clients that keep a SQLite copy (web: `@powersync/web` on wa-sqlite in IndexedDB; iOS: `powersync-swift` with GRDB). Writes go up through `POST /api/upload`, one single-row statement per write, column-level last write to arrive, delete wins. PowerSync streams the result back through a Worker proxy.

- **procrastimate** (`~/code/procrastimate`): 8 synced tables with `user_id`, multi-user sharing through an `access` table that the stream rules join, Better Auth, an agent API, push, images as `bytea` outside sync. One generator (`scripts/generate`, about 1,560 lines) derives the web `sqlite-core` tables, the PowerSync schemas and the Swift row types from the `pg-core` schema. It moved to PowerSync on 2026-10-18 (PR #189), replacing a home-grown engine.
- **a-better-me** (`~/code/a-better-me`): 8 tables, one owner, iOS only, no `user_id`. The Swift PowerSync schema and the Swift row codecs are written by hand, so the schema exists three times. Production sync is off: PowerSync's free plan allows two instances and procrastimate holds both, and the Supabase free plan's two projects are also procrastimate's, so a-better-me's database sits inside them.

Local dev needs Docker: one shared Postgres (tuned to 1,000 connections and 64 replication slots after 13 worktrees exhausted the defaults) and one PowerSync container per worktree, with a second Postgres database for PowerSync's storage, replication-slot garbage collection, and a startup order of migrate, then PowerSync, then poll for `sync_rules ACTIVE`.

## The home-grown engine procrastimate already retired

procrastimate's first sync engine (PRs #28 to #104, October 2026) stored entities as JSON blobs with one hybrid logical clock per field, an append-only `log(seq)`, paging, an epoch and reset protocol, a realtime "sync now" WebSocket nudge on an `Account` Durable Object, and Swift ports of the merge. Data moved from the Durable Object's SQLite to Turso in PR #54. The retirement doc (`docs/postgres-powersync.md`) gives three reasons: every request loaded and rewrote the whole account on Turso (about 1,540 reads and 3,080 writes per request, 2.9 s median sync over 29 round trips), the merge was ours (about 2,000 lines plus 1,600 of tests, 8 `fix(sync)` commits in 10 days), and the team wanted an off-the-shelf engine.

None of those three is inherent to an own engine. The slowness came from remote SQLite over HTTP with whole-account rewrites. The bug count came from per-field clocks, paging, epochs and a merge that ran on every client in two languages. The design below keeps none of those.

## Row mirror versus action log

Option A syncs resulting rows (put with all columns, patch with changed columns, delete). Option B syncs named actions and every side reduces them with the same code.

A wins for these apps. The server accepts a write with no app logic (validate columns, upsert). The Swift port is an outbox and a row applier, not every reducer. A schema change is an additive `ALTER` on both sides, or a client re-pull, instead of versioned actions that can never be removed and a full replay to rebuild state (LiveStore documents exactly that cost). Non-sync readers such as the agent API, push and backups read tables directly. Both apps already compute row writes from pure store rules (`rowWrites(before, after)` in procrastimate, GRDB `updateChanges` diffs in a-better-me), and both already avoid intent conflicts by sending resulting values (a recurring completion sends the next due date). B's remaining advantage, a built-in audit log and undo, is covered by keeping an append-only log of applied row writes next to the mirror, which procrastimate already has.

## Where the server runs

Cloudflare Durable Objects with SQLite storage. The free plan allows 100k requests a day, 5M rows read and 100k rows written a day, and 5 GB. An object is created on first use, so a new environment is a `wrangler deploy` with no database to provision. Writes are serialized per object, which gives per-space ordering without advisory locks. WebSockets with hibernation deliver the "pull now" nudge at no duration cost. `wrangler dev` runs it locally with state in `.wrangler/state` and took about 1 s to the first request in a measured scaffold. Point in time recovery covers 30 days.

Rejected: D1 (10 databases per account on the free plan, no push channel), Turso with Lambda or Vercel (every query is an HTTP hop, Swift SDK is a preview, no live channel), Lambda with DynamoDB (not SQL, so the client and server schemas diverge), Neon or Supabase (cold starts or pausing, Docker locally, and the Postgres-to-SQLite type mapping we have today), self-hosted PowerSync (always-on by design). Deno Deploy shuts down in about six months per Deno's 2026-10-09 announcement.

The engine core is plain TypeScript over a small SQL driver interface, so bun:sqlite runs it in tests and D1 or libsql can run it if Cloudflare ever stops being the right host.

## Protocol

Replicache's push and pull shape with per-client sequence numbers, carrying row writes instead of mutations.

- Client SQLite holds the app tables with the same DDL as the server, `_outbox(seq, table, id, op, values)` and `_meta(cursor, clientId)`. A command updates rows and appends to the outbox in one transaction; the UI renders from local state on the first frame.
- `POST /sync {clientId, cursor, writes}` applies each write in one transaction on the object: skip if `seq` is at or below the client's last acked `seq`, validate with the generated Zod schema, upsert, patch or delete, set `_changes[table, id] = ++head`, append a `_log` row. The response is `{ackedSeq, rejected[], rows changed since cursor, cursor: head}`. A pull is the same call with no writes. A cursor older than the compaction horizon gets a full snapshot.
- Conflicts: column-level last write to arrive, delete beats a later patch, a patch to a missing row is a no-op. A rejected write is dropped from the outbox and the next pull restores the server's row.
- After each push the object sends `{cursor}` to every open WebSocket. Clients pull when the cursor is past their own.

## Schema and types

One `schema.ts` per app in Drizzle `sqlite-core`. A generator writes the SQLite DDL and migrations (identical on client and server), the Zod row validators, the Swift structs with GRDB conformance and the table list, and a schema hash. The server applies additive migrations at object start. A client whose hash differs after an additive change applies the same `ALTER`s; after a destructive change it pushes its outbox, drops the local database and pulls a snapshot. No backwards compatibility, which both apps already state as policy. A test asserts that the client DDL, the server DDL and the Swift table list agree, so an agent's schema change fails loudly if any output is stale.

## Open risks

- The web storage layer (sqlite-wasm with OPFS in a SharedWorker so all tabs share one connection) is new code that PowerSync currently provides. Safari 16.4+ supports the needed VFS.
- procrastimate's sharing needs one object per space and clients that subscribe to several spaces, with guest writes checked against `access` inside the owner's object. a-better-me needs one object per app.
- Images (up to 1.5 MB) exceed nothing on the object's 2 MB row limit, but they belong in R2 with a key in the row.
- Each WebSocket message counts as a request on the free plan. Nudges are the only messages.
- Cloudflare's free plan lists both 10 GB and 1 GB per object in different places. Neither matters at these sizes.

## Suggested order

1. Engine core with bun:sqlite tests, the Durable Object adapter and the TypeScript client.
2. a-better-me first: one owner, iOS only, and its production sync is off today, so the move is a strict gain.
3. procrastimate: spaces, sharing, the agent API and push on object alarms.
