import { Database } from 'bun:sqlite';
import type { Row, SqlDriver, SqlValue } from '@sync-engine/core';

export function bunSqlite(pathOrDatabase: string | Database): SqlDriver {
	const db = typeof pathOrDatabase === 'string' ? new Database(pathOrDatabase, { create: true }) : pathOrDatabase;
	if (typeof pathOrDatabase === 'string' && pathOrDatabase !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
	return {
		exec: (sql: string, params: SqlValue[] = []) => db.query<Row, SqlValue[]>(sql).all(...params),
		transaction: fn => db.transaction(fn)(),
	};
}
