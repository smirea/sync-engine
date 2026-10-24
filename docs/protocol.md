# Protocol v1

The exact shapes every implementation shares: the TypeScript core and clients, the Swift client, and the Bend model in `spec/`. The decisions behind them are in [`decisions/sync.md`](decisions/sync.md).

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

`_meta` holds `head` (the last assigned seq, 0 on a fresh space). `_changes` keeps one row per app row ever written, with `deleted = 1` as a tombstone. Tombstones are never compacted in v1, so `pull` from any cursor is exact and a snapshot is only needed for `cursor = 0`.

## Client tables

```sql
CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, "table" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, col TEXT);
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value);
```

`_meta` holds `client` (a UUID minted once per install), `cursor` (0 on a fresh database), and `applying` (1 while pulled rows are being written, else absent or 0).

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

Each write carries `seq` = the largest outbox `seq` in its group. A `put` or `patch` whose row no longer exists locally is dropped, never turned into a `delete`; its outbox rows go with the acked ones. Outbox rows whose `seq` is at or below the acked `seq` are deleted after a successful sync.

## Request

`POST /sync` with the app's own authorization. JSON body:

```json
{
	"protocol": 1,
	"client": "4f0a...",
	"cursor": 42,
	"writes": [
		{ "seq": 7, "table": "workout_templates", "id": "a1", "op": "put", "values": { "name": "Push", "archived": 0 } },
		{ "seq": 9, "table": "settings", "id": "settings", "op": "patch", "values": { "weight_unit": "lb" } },
		{ "seq": 11, "table": "body_weights", "id": "b7", "op": "delete" }
	]
}
```

`writes` may be empty, which makes the call a pull. Values are JSON `string`, `number`, or `null`. A `put` must carry every `NOT NULL` column without a default.

## Server apply

In one transaction, in ascending `seq` order (the server sorts the batch, since coalescing emits groups in first-seen order with each group's largest `seq`), for each write:

1. If `seq <= _clients[client]`, skip it, and otherwise set `_clients[client] := seq` before the next write. This is the exactly-once replay rule, and it is what the Bend model proves.
2. Validate: known table, known op, column names filtered to the schema, storage class per column, `NOT NULL` respected, the app's optional validator per column (for JSON shapes). A failure puts `{ seq, table, id, reason }` into `rejected` and the write is otherwise skipped.
3. `put`: upsert the full row with `INSERT ... ON CONFLICT (id) DO UPDATE SET` every column (missing nullable columns become their default or null). Never `INSERT OR REPLACE`: it is a delete plus an insert and cascades through foreign keys. `patch`: `UPDATE` the named columns; if no row exists, the write is a no-op and not counted. `delete`: `DELETE`, counted even when no row exists, so the tombstone reaches clients that still hold the row.
4. For a counted write: `head := head + 1`, `_changes[(table, id)] := (head, deleted)`, and one `_log` row.
5. `_clients[client] := max(_clients[client], max(seq) over the batch)`, applied even when writes were rejected or no-ops, so the client clears its outbox. `acked` in the response is that stored value.
6. For every rejected write, the current server row or tombstone for its `(table, id)` is included in `rows` whatever its `seq`, so the client replaces the value the server refused.

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
	]
}
```

`rows` are every `_changes` entry with `seq > cursor`, joined with the current full row. With `cursor = 0`, `snapshot` is `true` and `rows` holds every live row and no tombstones; the client deletes every local app row first. There is no paging in v1. Status codes: 200 on success even with rejections; 400 for a body that is not this shape; 401 from the app's auth; 426 when `protocol` is not 1.

## Client apply

First, if the request carried writes and `acked` is greater than the largest `seq` it sent, the database is a restored backup or a copy sharing a client id with another device: mint a new `_meta.client`, keep the outbox, and discard the response; the next sync re-sends everything under the new id.

Otherwise, in one transaction: set `_meta.applying = 1`; if `snapshot`, delete every row of every app table except rows that have a pending `_outbox` entry with `seq > acked`; for each row, skip it when `_outbox` holds a pending entry for its `(table, id)` whose `seq` is above `acked` (the next sync re-sends that write and the row comes back merged); otherwise `DELETE` for a tombstone or upsert (`INSERT ... ON CONFLICT (id) DO UPDATE SET`) for a live row; delete `_outbox` rows with `seq <= acked`; set `_meta.cursor = head`; set `_meta.applying = 0`. Then notify observers of the touched tables.

## Live updates

The server exposes a WebSocket at `/live` with the same authorization. After any sync that advanced `head`, it sends `{"head": 57}` to every connected client, the writer included. A client pulls when `head > cursor`. The message carries nothing else, so a lost message only delays a pull until the next trigger (launch, foreground, network regained, a local write, a periodic timer).

## What the Bend model covers

`spec/sync.bend` models `apply`, `pull`, and `applyPull` over opaque naturals: tables, ids, columns and values are `Nat`, `_changes` is the model's `changes`, `_clients` is `clients`, and the pending-outbox skip in client apply is not modeled (the model's client has no outbox). `spec/vectors.json` is generated from the model's JavaScript build and replayed through the TypeScript core in `packages/core/spec.test.ts`.
