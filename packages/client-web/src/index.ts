import type { DrizzleConfig } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqlValue, SyncResponse } from '../../core/src/index.ts';
import {
	SyncWebError,
	type Call,
	type Input,
	type Kind,
	type Output,
	type QueryResult,
	type Statement,
	type ToTab,
	type WebSyncStatus,
} from './protocol.ts';

export { SyncWebError };
export type { ErrorCode, QueryResult, Statement, WebSyncStatus } from './protocol.ts';
export type { SyncWorkerOptions } from './worker.ts';

export type WebDatabase = {
	exec(sql: string, params?: SqlValue[]): Promise<QueryResult>;
	/** Runs every statement in one transaction and answers one result per statement. */
	batch(statements: Statement[]): Promise<QueryResult[]>;
	sync(): Promise<SyncResponse>;
	status(): Promise<WebSyncStatus>;
	/** A string starts or re-authenticates the sync loop, `null` stops it. Reaches every tab's worker. */
	setToken(token: string | null): Promise<void>;
	/** Fires with the tables a local write or a pull touched, in this tab or any other. */
	onChange(listener: (tables: ReadonlySet<string>) => void): () => void;
	/** Closes this tab's worker. Another tab's worker takes over the database when this one hosted it. */
	close(): Promise<void>;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: SyncWebError) => void };

export function openSyncDatabase({ worker }: { worker: Worker }): WebDatabase {
	const pending = new Map<number, Pending>();
	const listeners = new Set<(tables: ReadonlySet<string>) => void>();
	let next = 1;
	let closed = false;

	const fail = (error: SyncWebError) => {
		for (const { reject } of pending.values()) reject(error);
		pending.clear();
	};
	worker.addEventListener('message', ({ data }: MessageEvent<ToTab>) => {
		if (!('id' in data)) {
			const tables = new Set(data.tables);
			for (const listener of listeners) listener(tables);
			return;
		}
		const waiting = pending.get(data.id);
		if (!waiting) return;
		pending.delete(data.id);
		if (data.ok) waiting.resolve(data.result);
		else waiting.reject(new SyncWebError(data.error.code, data.error.message));
	});
	worker.addEventListener('error', event => fail(new SyncWebError('open-failed', event.message)));

	function call<K extends Kind>(kind: K, input: Input<K>): Promise<Output<K>> {
		if (closed) return Promise.reject(new SyncWebError('closed', 'the database is closed'));
		const id = next++;
		return new Promise<Output<K>>((resolve, reject) => {
			pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			worker.postMessage({ id, kind, ...input } as Call<K>);
		});
	}

	return {
		exec: (sql, params = []) => call('exec', { sql, params }),
		batch: statements => call('batch', { statements }),
		sync: () => call('sync', {}),
		status: () => call('status', {}),
		setToken: async token => void (await call('setToken', { token })),
		onChange(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		async close() {
			await call('close', {});
			closed = true;
			worker.terminate();
			fail(new SyncWebError('closed', 'the database is closed'));
		},
	};
}

type Method = 'run' | 'all' | 'values' | 'get';
const shape = (method: Method, result: QueryResult) => ({
	rows: method === 'get' ? (result.rows[0] as unknown[]) : method === 'run' ? [] : result.rows,
});

/**
 * Drizzle over the worker. `db.batch([...])` is the transactional form; `db.transaction()` sends a bare `BEGIN`,
 * which the shared connection refuses with `explicit-transaction`.
 */
export function drizzleSyncDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
	db: WebDatabase,
	config?: DrizzleConfig<TSchema>,
) {
	return drizzle<TSchema>(
		async (sql, params, method) => shape(method, await db.exec(sql, params as SqlValue[])),
		async statements => {
			const results = await db.batch(
				statements.map(statement => ({ sql: statement.sql, params: statement.params as SqlValue[] })),
			);
			return results.map((result, i) => shape(statements[i]!.method, result));
		},
		config,
	);
}
