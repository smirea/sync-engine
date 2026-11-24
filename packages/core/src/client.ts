import { migrate } from "./schema.ts";
import { rowKey, upsert } from "./sql.ts";
import type {
  After,
  Refresh,
  Schema,
  SqlDriver,
  SqlValue,
  SyncRequest,
  SyncResponse,
  Table,
  Value,
  Values,
  Write,
} from "./types.ts";

/** A paged snapshot in progress: the page to request next and the head of its first page, the cursor once it ends. */
export type SnapshotProgress = { after: After; head: number };

/** The tables a response changed, and whether the sync needs another request before it is done. */
export type Applied = { tables: Set<string>; more: boolean };

export type Client = {
  migrate(): void;
  collect(): { writes: Write[]; acked: number };
  /** The next request: the cursor and space, plus the page of a snapshot in progress or the tables to refresh. */
  request(writes: Write[]): Extract<SyncRequest, { protocol: 2 }>;
  apply(response: SyncResponse, acked: number): Applied;
  cursor(): number;
  /** The space the cursor came from, `''` before the first response that names one. */
  space(): string;
  snapshot(): SnapshotProgress | null;
  /** The tables the schema grew that are still to be pulled whole, else null. */
  refresh(): Refresh | null;
  pending(): number;
  clientId(): string;
  /**
   * Empties every app table and the outbox and starts over under a new client id at cursor 0, as a fresh database
   * would: for an app that signs another user in on the same device. Captures nothing. Answers the tables it emptied.
   */
  reset(): Set<string>;
};

/**
 * The rows a snapshot in progress has delivered. The client creates it, not the schema's DDL: no generated statement
 * names it, and an app that ships that DDL as a generated file pins the generator and the client separately.
 */
const SEEN_DDL =
  'CREATE TABLE IF NOT EXISTS _seen ("table" TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY ("table", id)) WITHOUT ROWID';

/**
 * The values `_seen` was last written for. Another engine version that applies a page moves one of them without
 * recording the rows it stored, as a build from before `_seen` does after a rollback, so a mismatch at migrate means
 * `_seen` no longer describes the pages in the database.
 */
const SEEN_FOR = `(SELECT group_concat(coalesce((SELECT value FROM _meta WHERE key = name), ''), char(10)) FROM (SELECT 'cursor' AS name UNION ALL SELECT 'after' UNION ALL SELECT 'snapshot_head' UNION ALL SELECT 'refresh'))`;

type Group = { table: string; id: string; seq: number; ops: string[]; cols: Set<string> };

export function createClient(driver: SqlDriver, schema: Schema): Client {
  const tables = new Map(schema.tables.map((table) => [table.name, table]));

  const meta = (name: string) =>
    driver.exec("SELECT value FROM _meta WHERE key = ?", [name])[0]?.value;
  const setMeta = (name: string, value: SqlValue) =>
    driver.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", [name, value]);
  const snapshot = (): SnapshotProgress | null => {
    const after = meta("after");
    return after
      ? { after: JSON.parse(String(after)) as After, head: Number(meta("snapshot_head")) }
      : null;
  };
  const refresh = (): Refresh | null => {
    const stored = meta("refresh");
    return stored ? (JSON.parse(String(stored)) as Refresh) : null;
  };
  const dropMeta = (...names: string[]) =>
    driver.exec(`DELETE FROM _meta WHERE key IN (${names.map(() => "?").join(", ")})`, names);

  const readRow = (table: Table, id: string): Values | null => {
    const row = driver.exec(
      `SELECT ${table.columns.map((c) => c.name).join(", ")} FROM ${table.name} WHERE id = ?`,
      [id],
    )[0];
    return row
      ? (Object.fromEntries(table.columns.map((c) => [c.name, row[c.name] as Value])) as Values)
      : null;
  };

  function collect() {
    const groups = new Map<string, Group>();
    let acked = 0;
    for (const row of driver.exec('SELECT seq, "table", id, op, col FROM _outbox ORDER BY seq')) {
      const seq = Number(row.seq);
      acked = seq;
      const k = rowKey(String(row.table), String(row.id));
      const group = groups.get(k) ?? {
        table: String(row.table),
        id: String(row.id),
        seq,
        ops: [],
        cols: new Set(),
      };
      group.seq = seq;
      group.ops.push(String(row.op));
      if (row.col !== null) group.cols.add(String(row.col));
      groups.set(k, group);
    }
    const writes: Write[] = [];
    for (const { table, id, seq, ops, cols } of groups.values()) {
      if (ops.at(-1) === "delete") {
        writes.push({ seq, table, id, op: "delete" });
        continue;
      }
      const definition = tables.get(table);
      const row = definition && readRow(definition, id);
      if (!row) continue;
      if (ops.includes("insert")) writes.push({ seq, table, id, op: "put", values: row });
      else
        writes.push({
          seq,
          table,
          id,
          op: "patch",
          values: Object.fromEntries([...cols].map((c) => [c, row[c]!])),
        });
    }
    return { writes, acked };
  }

  function request(writes: Write[]): Extract<SyncRequest, { protocol: 2 }> {
    const progress = snapshot();
    const tables = progress ? null : refresh();
    return {
      protocol: 2,
      client: String(meta("client")),
      cursor: Number(meta("cursor")),
      writes,
      ...(progress ? { after: progress.after } : {}),
      space: String(meta("space") ?? ""),
      ...(tables ? { refresh: tables } : {}),
    };
  }

  function apply(response: SyncResponse, acked: number): Applied {
    return driver.transaction(() => {
      const touched = new Set<string>();
      if (acked > 0 && response.acked > acked) {
        // The server knows this client id past what we sent: a restored backup or a copied database. Under a
        // fresh id the next sync re-sends the outbox instead of having it skipped as a replay.
        setMeta("client", crypto.randomUUID());
        return { tables: touched, more: false };
      }
      setMeta("applying", 1);
      // The server answers another space's cursor with a full snapshot from its first page, so pages fetched before
      // and a refresh under way belong to the old space.
      const moved = response.space !== undefined && response.space !== String(meta("space") ?? "");
      if (moved) {
        setMeta("space", response.space!);
        dropMeta("after", "snapshot_head", "refresh");
      }
      const progress = snapshot();
      const refreshing = refresh();
      const scoped = response.snapshot && response.tables !== undefined;
      const full = response.snapshot && !scoped;
      // A full snapshot holds the refreshed tables too.
      if (full && refreshing) dropMeta("refresh");
      const first = (full && !progress) || (scoped && !refreshing?.after);
      if (first) driver.exec("DELETE FROM _seen");
      if (response.snapshot && !first) {
        // The page of a row pushed with a later page may already have gone by, so the snapshot's silence is no
        // verdict on it. A write that landed did so after the cursor this snapshot ends on, and the next delta
        // says what became of its row. One that did not land comes back as a row of this response. A write acked
        // with the first page landed before any page was read, so the snapshot itself is the verdict.
        driver.exec(
          'INSERT OR IGNORE INTO _seen ("table", id) SELECT "table", id FROM _outbox WHERE seq <= ?',
          [acked],
        );
      }
      driver.exec("DELETE FROM _outbox WHERE seq <= ?", [acked]);
      const pending = new Set(
        driver
          .exec('SELECT "table", id FROM _outbox')
          .map((row) => rowKey(String(row.table), String(row.id))),
      );
      for (const pulled of response.rows) {
        const table = tables.get(pulled.table);
        if (!table || pending.has(rowKey(pulled.table, pulled.id))) continue;
        if (pulled.deleted) {
          if (
            driver.exec(`DELETE FROM ${table.name} WHERE id = ? RETURNING 1`, [pulled.id]).length
          ) {
            touched.add(table.name);
          }
          continue;
        }
        const columns = table.columns.filter((c) => c.name !== "id");
        const values = Object.fromEntries(
          columns.map((c) => {
            const value = pulled.values[c.name];
            return [c.name, value === undefined ? (c.default ?? null) : value];
          }),
        );
        if (upsert(driver, table.name, pulled.id, values)) touched.add(table.name);
        if (response.snapshot) {
          driver.exec('INSERT OR IGNORE INTO _seen ("table", id) VALUES (?, ?)', [
            table.name,
            pulled.id,
          ]);
        }
      }
      if (response.snapshot && !response.next) {
        // The snapshot is whole: what it did not hold is gone from the server. Rows are never emptied first, so a
        // snapshot of an unchanged space writes to no app table.
        const held = scoped
          ? schema.tables.filter((table) => response.tables!.includes(table.name))
          : schema.tables;
        for (const table of held) {
          const gone = driver.exec(
            `DELETE FROM ${table.name} WHERE id NOT IN (SELECT id FROM _seen WHERE "table" = ?) AND id NOT IN (SELECT id FROM _outbox WHERE "table" = ?) RETURNING 1`,
            [table.name, table.name],
          );
          if (gone.length) touched.add(table.name);
        }
        driver.exec("DELETE FROM _seen");
      }
      let more: boolean;
      if (scoped) {
        // The cursor stays: the delta from it follows the last page and brings what changed while paging.
        const pulling = refreshing?.tables ?? response.tables!;
        if (response.next)
          setMeta("refresh", JSON.stringify({ tables: pulling, after: response.next }));
        else dropMeta("refresh");
        more = true;
      } else if (response.next) {
        setMeta("after", JSON.stringify(response.next));
        setMeta("snapshot_head", progress?.head ?? response.head);
        more = true;
      } else if (!full && refreshing) {
        // A delta answered a refresh: the server is older than refresh and dropped it. A full snapshot is the
        // only other way to the rows stored before the tables grew.
        setMeta("cursor", 0);
        dropMeta("refresh");
        more = true;
      } else {
        // The first page's head: rows that changed while later pages were fetched come with the next delta.
        setMeta("cursor", progress?.head ?? response.head);
        dropMeta("after", "snapshot_head");
        more = false;
      }
      driver.exec(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('seen', ${SEEN_FOR})`);
      setMeta("applying", 0);
      return { tables: touched, more };
    });
  }

  const start = () =>
    driver.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('client', ?), ('cursor', 0)", [
      crypto.randomUUID(),
    ]);

  return {
    migrate: () =>
      driver.transaction(() => {
        const grown = migrate(driver, schema, "client");
        driver.exec(SEEN_DDL);
        start();
        const paging = snapshot() !== null;
        const pulling = refresh();
        // Pages another engine version applied are not in `_seen`, so the last page would take their rows for
        // rows the server lacks: a snapshot starts over, and a refresh starts its pages over.
        const untracked =
          (paging || pulling?.after !== undefined) &&
          driver.exec(
            `SELECT (SELECT value FROM _meta WHERE key = 'seen') IS ${SEEN_FOR} AS same`,
          )[0]!.same === 0;
        if (untracked && pulling) setMeta("refresh", JSON.stringify({ tables: pulling.tables }));
        if (!grown.length && !(untracked && paging)) return;
        // Rows pulled before a table or a column existed were stored without it, and a delta resends a row only
        // when it changes, so the grown tables are pulled whole again. A cursor that gets a full snapshot anyway,
        // or one in progress whose earlier pages predate the growth, starts that snapshot over instead.
        if (Number(meta("cursor")) === 0 || paging) {
          setMeta("cursor", 0);
          dropMeta("after", "snapshot_head", "refresh");
        } else {
          setMeta(
            "refresh",
            JSON.stringify({ tables: [...new Set([...(refresh()?.tables ?? []), ...grown])] }),
          );
        }
      }),
    reset: () =>
      driver.transaction(() => {
        setMeta("applying", 1);
        for (const table of schema.tables) driver.exec(`DELETE FROM ${table.name}`);
        driver.exec("DELETE FROM _outbox");
        driver.exec("DELETE FROM _seen");
        driver.exec("DELETE FROM _meta");
        start();
        return new Set(schema.tables.map((table) => table.name));
      }),
    collect,
    request,
    apply,
    cursor: () => Number(meta("cursor")),
    space: () => String(meta("space") ?? ""),
    snapshot,
    refresh,
    pending: () => Number(driver.exec("SELECT count(*) AS n FROM _outbox")[0]!.n),
    clientId: () => String(meta("client")),
  };
}
