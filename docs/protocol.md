# Protocol v2

The exact shapes every implementation shares: the TypeScript core and clients, the Swift client, and the Bend model in `spec/`. The decisions behind them are in [`decisions/sync.md`](decisions/sync.md).

Protocol 2 adds horizon compaction on the server and paged snapshots. A server accepts protocol 1 and protocol 2 for one release; see [Protocol 1](#protocol-1) for what a v1 request gets.

## App tables

Every synced table has `id TEXT PRIMARY KEY`. Columns use SQLite storage classes only: `TEXT`, `INTEGER`, `REAL`. JSON is `TEXT`. Booleans are `INTEGER` 0 or 1. Timestamps are whatever text or integer the app chooses; the engine never interprets them. The DDL is identical on the server and on every client, generated from the app's Drizzle `sqlite-core` schema.

Schema evolution is additive only. On start, server and client compare `PRAGMA table_info` with the schema and run `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` for what is missing. A removed column stays in place and is ignored. A column whose type must change gets a new name. Unknown columns in a write are ignored by the server; unknown columns in a pulled row are ignored by the client.

## Server tables

```sql
CREATE TABLE IF NOT EXISTS _changes ("table" TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("table", id));
CREATE INDEX IF NOT EXISTS _changes_seq ON _changes (seq);
CREATE TABLE IF NOT EXISTS _clients (client TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _log (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, client TEXT NOT NULL, "table" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, "values" TEXT);
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value);
```

`_meta` holds three integers, all 0 on a fresh space and inserted with `INSERT OR IGNORE` on every migrate, so an existing space gains them on upgrade:

- `head`: the last assigned seq.
- `horizon`: every tombstone with `seq <= horizon` may be gone. A pull from a cursor below it gets a snapshot.
- `compacted_at`: when compaction last ran, in the server's clock (`Date.now()` milliseconds unless the space was given another clock).

`_changes` keeps one row per app row written since the horizon, with `deleted = 1` as a tombstone. A live row's entry is never removed, since delta pulls need it. `_log.at` is the server clock at the write.

### Compaction

A space has `retention` (default 30 days) and `compactEvery` (default one hour). At the end of a sync, after the response is computed, when `now - compacted_at > compactEvery`, the server compacts in the same transaction:

1. `horizon := max(horizon, max(_log.seq) where _log.at < now - retention)`.
2. `DELETE FROM _changes WHERE deleted = 1 AND seq <= horizon`.
3. `DELETE FROM _log WHERE seq <= horizon`.
4. Store `horizon` and `compacted_at := now`.

`space.compact()` runs the same steps on demand and returns the horizon. The horizon never decreases. A tombstone written for a rejected insert follows the same rule as any other.

## Client tables

```sql
CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, "table" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, col TEXT);
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value);
```

`_meta` holds:

- `client`: a UUID minted once per install.
- `cursor`: 0 on a fresh database.
- `applying`: 1 while pulled rows are being written, else absent or 0.
- `after` and `snapshot_head`: present together only while a paged snapshot is in progress. `after` is the JSON `{"table": ..., "id": ...}` of the last row received, `snapshot_head` the `head` of the snapshot's first page. Both are written and cleared in the same transaction as the rows they describe.

Writes are captured by generated triggers, one set per app table, so no client code can forget to queue a change:

```sql
CREATE TRIGGER IF NOT EXISTS _ob_i_<t> AFTER INSERT ON <t>
  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0
  BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('<t>', NEW.id, 'insert', NULL); END;
CREATE TRIGGER IF NOT EXISTS _ob_d_<t> AFTER DELETE ON <t>
  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0
  BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('<t>', OLD.id, 'delete', NULL); END;
-- one per column c, id excluded
CREATE TRIGGER IF NOT EXISTS _ob_u_<t>_<c> AFTER UPDATE OF <c> ON <t>
  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.<c> IS NOT NEW.<c>
  BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('<t>', NEW.id, 'update', '<c>'); END;
```

The outbox stores no values. At push time the client reads the current row, so a column edited five times offline is sent once with its latest value.

## Coalescing the outbox into writes

Group outbox rows by `(table, id)`, ordered by the group's first `seq`. For each group:

- If the last op is `delete`: one `delete` write.
- Else if any op is `insert`: one `put` write with every column of the current row.
- Else: one `patch` write with the current values of the distinct `col`s recorded.

Each write carries `seq` = the largest outbox `seq` in its group. A `put` or `patch` whose row no longer exists locally is dropped, never turned into a `delete`; its outbox rows go with the acked ones. Outbox rows whose `seq` is at or below the acked `seq` are deleted after a successful sync. The writes leave in group order, which is not seq order: `[insert n1, insert n2, update n1]` yields seqs `[3, 2]`. The server sorts.

## Request

`POST /sync` with the app's own authorization. JSON body:

```json
{
	"protocol": 2,
	"client": "4f0a...",
	"cursor": 42,
	"writes": [
		{ "seq": 7, "table": "workout_templates", "id": "a1", "op": "put", "values": { "name": "Push", "archived": 0 } },
		{ "seq": 9, "table": "settings", "id": "settings", "op": "patch", "values": { "weight_unit": "lb" } },
		{ "seq": 11, "table": "body_weights", "id": "b7", "op": "delete" }
	],
	"after": { "table": "workout_templates", "id": "a1" }
}
```

`writes` may be empty, which makes the call a pull. Values are JSON `string`, `number`, or `null`. A `put` must carry every `NOT NULL` column without a default. `after` is optional and only meaningful on a snapshot: it is the `next` of the previous page, and the response continues after that row. The server ignores `after` on a delta.

## Server apply

In one transaction, in ascending `seq` order (the server sorts the batch, since coalescing emits groups in first-seen order with each group's largest `seq`), for each write:

1. If `seq <= _clients[client]`, skip it, and otherwise set `_clients[client] := seq` before the next write. This is the exactly-once replay rule, and it is what the Bend model proves.
2. Validate: known table, known op, column names filtered to the schema, storage class per column, `NOT NULL` respected, the app's optional validator per column (for JSON shapes). An `id` validator runs against the write's `id` for `put` and `patch`, and its failure reads `id: <message>`. A failure puts `{ seq, table, id, reason }` into `rejected` and the write is otherwise skipped.
3. `put`: upsert the full row with `INSERT ... ON CONFLICT (id) DO UPDATE SET` every column (missing nullable columns become their default or null). Never `INSERT OR REPLACE`: it is a delete plus an insert and cascades through foreign keys. `patch`: `UPDATE` the named columns; if no row exists, the write is a no-op and not counted. `delete`: `DELETE`, counted even when no row exists, so the tombstone reaches clients that still hold the row.
4. For a counted write: `head := head + 1`, `_changes[(table, id)] := (head, deleted)`, and one `_log` row.
5. `_clients[client] := max(_clients[client], max(seq) over the batch)`, applied even when writes were rejected or no-ops, so the client clears its outbox. `acked` in the response is that stored value.
6. For every rejected write, the current server row or tombstone for its `(table, id)` is included in `rows` whatever its `seq`, so the client replaces the value the server refused. A rejected row whose `_changes` entry was compacted comes back as a tombstone.

Then the pull (below), then compaction when due.

Conflicts resolve as column-level last write to arrive. A delete beats a later patch. A rejected write is dropped by the client; the server's row comes back in the same response if it changed since the cursor.

## Response

```json
{
	"head": 57,
	"acked": 11,
	"rejected": [{ "seq": 9, "table": "settings", "id": "settings", "reason": "weight_unit: expected kg or lb" }],
	"snapshot": false,
	"rows": [
		{
			"table": "workout_templates",
			"id": "a1",
			"deleted": 0,
			"values": { "id": "a1", "name": "Push", "archived": 0, "...": "every column" }
		},
		{ "table": "body_weights", "id": "b7", "deleted": 1 }
	],
	"next": null
}
```

The server answers a **snapshot** when `cursor = 0` or `cursor < horizon`, else a **delta**.

- Delta: `snapshot` is `false`, `rows` are every `_changes` entry with `seq > cursor` joined with the current full row, `next` is `null`.
- Snapshot: `snapshot` is `true`, `rows` holds live rows only, in schema table order then by `id` (SQLite's default text order), starting after `after` when the request carried one, at most `pageSize` rows (space option, default 1000). `next` is the `{ table, id }` of the last row when more rows follow, else `null`. Every page carries the current `head`.

Status codes: 200 on success even with rejections; 400 for a body that is not this shape; 401 from the app's auth; 426 when `protocol` is not 1 or 2.

## Client apply

First, if the request carried writes and `acked` is greater than the largest `seq` it sent, the database is a restored backup or a copy sharing a client id with another device: mint a new `_meta.client`, keep the outbox, and discard the response; the next sync re-sends everything under the new id.

Otherwise, in one transaction:

1. Set `_meta.applying = 1`. Read `_meta.after` and `_meta.snapshot_head`; together they say a paged snapshot is in progress.
2. If `snapshot` and no snapshot is in progress, delete every row of every app table except rows that have a pending `_outbox` entry with `seq > acked`. A page requested with `after` never wipes.
3. For each row, skip it when `_outbox` holds a pending entry for its `(table, id)` whose `seq` is above `acked` (the next sync re-sends that write and the row comes back merged); otherwise `DELETE` for a tombstone or upsert (`INSERT ... ON CONFLICT (id) DO UPDATE SET`) for a live row.
4. Delete `_outbox` rows with `seq <= acked`.
5. If `next` is set: store `_meta.after := next` and `_meta.snapshot_head := snapshot_head ?? head`, leave `_meta.cursor` alone. Else: `_meta.cursor := snapshot_head ?? head` and delete `after` and `snapshot_head`.
6. Set `_meta.applying = 0`. Then notify observers of the touched tables.

The cursor lands on the **first** page's head, not the last, so a row that changed while later pages were fetched is re-pulled by the next delta.

### The sync loop

One sync is: collect the outbox, send it with `cursor` and, when `_meta.after` is set, that `after`; apply the response; while `_meta.after` is still set, send `{ writes: [], cursor, after }` and apply, until it clears. A client that crashes between pages resumes from `_meta.after` on its next sync and does not wipe again. The outbox collected after the first request waits for the next sync.

## Protocol 1

A `{ "protocol": 1, ... }` request is served as before: a snapshot carries every live row in one response and the response has no `next` key. Protocol 1 ignores the horizon on the client side by construction: a v1 client at a cursor below the horizon gets a full snapshot like cursor 0 and wipes, which is what it already does for `snapshot: true`. The removal condition is in [`decisions/sync.md`](decisions/sync.md).

## Live updates

The server exposes a WebSocket at `/live` with the same authorization. After any sync that advanced `head`, it sends `{"head": 57}` to every connected client, the writer included. A client pulls when `head > cursor`. The message carries nothing else, so a lost message only delays a pull until the next trigger (launch, foreground, network regained, a local write, a periodic timer).

## What the Bend model covers

`spec/sync.bend` models the server over opaque naturals: tables, ids, columns and values are `Nat`, `_changes` is the model's `changes`, `_clients` is `clients`, `_meta.horizon` is `horizon`. `apply` is one write; `applyBatch` sorts by seq and folds `apply`; `compact(s, h)` is compaction to horizon `h`; `pull(s, cursor)` answers `Snapshot{rows, head}` below the horizon (or at cursor 0) and `Delta{items, head}` above; `pullPage(s, after, n)` is one snapshot page. The client side is `applyPull` (no outbox skip) and `collect(client, local, outbox)`, the coalescing rule over `Entry{seq, table, id, op}`. `spec/vectors.json` is generated from the model's JavaScript build and replayed through the TypeScript core in `packages/core/spec.test.ts`, including compaction at a fixed write, an outbox through `collect` and one batch, and pages taken while writes land followed by a delta.
