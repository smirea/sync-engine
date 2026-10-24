import type { ZodType } from 'zod';

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface SqlDriver {
	exec(sql: string, params?: SqlValue[]): Row[];
	transaction<T>(fn: () => T): T;
}

export type Value = string | number | null;
export type Values = Record<string, Value>;

export type Write =
	| { seq: number; table: string; id: string; op: 'put'; values: Values }
	| { seq: number; table: string; id: string; op: 'patch'; values: Values }
	| { seq: number; table: string; id: string; op: 'delete' };

export type SyncRequest = { protocol: 1; client: string; cursor: number; writes: Write[] };
export type Rejected = { seq: number; table: string; id: string; reason: string };
export type PulledRow =
	| { table: string; id: string; deleted: 0; values: Values }
	| { table: string; id: string; deleted: 1 };
export type SyncResponse = { head: number; acked: number; rejected: Rejected[]; snapshot: boolean; rows: PulledRow[] };

export type StorageClass = 'TEXT' | 'INTEGER' | 'REAL';
export type Column = {
	name: string;
	type: StorageClass;
	notNull: boolean;
	default?: Value;
	json: boolean;
	validate?: ZodType;
};
export type Table = { name: string; columns: Column[] };
export type Schema = { tables: Table[]; ddl: { app: string[]; server: string[]; client: string[] } };
