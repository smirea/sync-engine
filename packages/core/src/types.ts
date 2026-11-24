import type { ZodType } from "zod";

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface SqlDriver {
  exec(sql: string, params?: SqlValue[]): Row[];
  transaction<T>(fn: () => T): T;
}

export type Value = string | number | null;
export type Values = Record<string, Value>;

export type Write =
  | { seq: number; table: string; id: string; op: "put"; values: Values }
  | { seq: number; table: string; id: string; op: "patch"; values: Values }
  | { seq: number; table: string; id: string; op: "delete" };

/** The last row of a snapshot page, by schema table order then id; the next page starts after it. */
export type After = { table: string; id: string };
/** The tables a client pulls whole again after its schema grew them, and where the next page of them starts. */
export type Refresh = { tables: string[]; after?: After };
export type SyncRequest =
  | { protocol: 1; client: string; cursor: number; writes: Write[] }
  | {
      protocol: 2;
      client: string;
      cursor: number;
      writes: Write[];
      after?: After;
      /** The space the cursor came from, `''` when the client has none yet. Left out by clients older than spaces. */
      space?: string;
      /** Left out by clients older than refresh, and ignored when the cursor gets a full snapshot anyway. */
      refresh?: Refresh;
    };
export type Rejected = { seq: number; table: string; id: string; reason: string };
export type PulledRow =
  | { table: string; id: string; deleted: 0; values: Values }
  | { table: string; id: string; deleted: 1 };
export type SyncResponse = {
  head: number;
  acked: number;
  rejected: Rejected[];
  snapshot: boolean;
  rows: PulledRow[];
  /** Protocol 2 only: where the next snapshot page starts, null on the last page and on every delta. */
  next?: After | null;
  /** The id this space minted when it was created. Servers older than spaces leave it out. */
  space?: string;
  /** Only on the answer to a refresh: the tables this snapshot holds, which are the requested ones the server has. */
  tables?: string[];
};

export type StorageClass = "TEXT" | "INTEGER" | "REAL";
export type Column = {
  name: string;
  type: StorageClass;
  notNull: boolean;
  default?: Value;
  json: boolean;
  validate?: ZodType;
};
export type Table = { name: string; columns: Column[] };
export type Schema = {
  tables: Table[];
  ddl: { app: string[]; server: string[]; client: string[] };
};
