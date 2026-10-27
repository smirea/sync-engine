import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { Row, Schema, SqlDriver, SqlValue } from '../../core/src/index.ts';
import { createSyncClient, type SyncClient, type SyncClientOptions } from '../../client/src/index.ts';
import {
	SyncWebError,
	type Bus,
	type Call,
	type ErrorCode,
	type Failure,
	type HostKind,
	type QueryResult,
	type Reply,
	type ToTab,
} from './protocol.ts';

export type SyncWorkerOptions = {
	schema: Schema;
	/** The server's base URL, such as `https://api.example.com`. */
	endpoint: string;
	/** The database file inside OPFS. One host per filename serves every tab of the origin. */
	filename: string;
	/** `undefined` starts the loop without auth, a string starts it with the token, `null` waits for `setToken`. */
	token?: string | null;
	/** Sent with every sync request, such as an app's own client header. */
	headers?: Record<string, string>;
	interval?: number;
	maxBackoff?: number;
	/** Where `sqlite3.wasm` is served from, when the bundler does not resolve it next to the worker script. */
	locateFile?: (file: string) => string;
};

type Host = {
	kind: 'host';
	sqlite3: Sqlite3Static;
	db: Database;
	client: SyncClient;
	clientOptions: SyncClientOptions;
	started: boolean;
	touched: Set<string>;
};
type Role =
	| { kind: 'peer'; inflight: Map<number, Call<HostKind>> }
	| { kind: 'opening'; inflight: Map<number, Call<HostKind>> }
	| Host
	| { kind: 'failed'; error: SyncWebError };

type WorkerScope = {
	postMessage(message: ToTab): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<Call>) => void): void;
	close(): void;
};
type InitModule = (config: {
	print: (text: string) => void;
	printErr: (text: string) => void;
	locateFile?: (file: string) => string;
}) => Promise<Sqlite3Static>;

type InstallPool = (
	options: Parameters<Sqlite3Static['installOpfsSAHPoolVfs']>[0] & { forceReinitIfPreviouslyFailed?: boolean },
) => ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>;

const OPEN_RETRY_MS = 100;
const OPEN_DEADLINE_MS = 3000;
const HELD_ERRORS = new Set(['NoModificationAllowedError', 'InvalidStateError']);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failure = (error: unknown, fallback: ErrorCode): Failure =>
	error instanceof SyncWebError
		? { code: error.code, message: error.message }
		: { code: fallback, message: message(error) };
const hidden = (table: string) => table.startsWith('_') || table.startsWith('sqlite_');

export function startSyncWorker(options: SyncWorkerOptions): void {
	const scope = self as unknown as WorkerScope;
	const name = `sync-engine:${options.filename}`;
	const bus = new BroadcastChannel(name);
	const from = crypto.randomUUID();
	const appTables = new Set(options.schema.tables.map(table => table.name));
	let token = options.token;
	let role: Role = { kind: 'peer', inflight: new Map() };
	let sqlite3Loading: Promise<Sqlite3Static> | null = null;
	const released = Promise.withResolvers<void>();

	if (typeof navigator.locks === 'undefined') void becomeHost();
	else void navigator.locks.request(name, () => becomeHost().then(() => released.promise));
	if (typeof token === 'string') bus.postMessage({ kind: 'token', token } satisfies Bus);
	else bus.postMessage({ kind: 'hello' } satisfies Bus);

	async function becomeHost() {
		const inflight =
			role.kind === 'peer' || role.kind === 'opening' ? role.inflight : new Map<number, Call<HostKind>>();
		role = { kind: 'opening', inflight };
		try {
			const host = await open();
			role = host;
			bus.postMessage({ kind: 'host' } satisfies Bus);
			for (const call of inflight.values()) scope.postMessage(await execute(host, call));
		} catch (error) {
			const typed = error instanceof SyncWebError ? error : new SyncWebError('open-failed', message(error));
			role = { kind: 'failed', error: typed };
			for (const call of inflight.values()) scope.postMessage(refuse(call, typed));
		}
	}

	async function open(): Promise<Host> {
		sqlite3Loading ??= (sqlite3InitModule as unknown as InitModule)({
			print: () => {},
			printErr: () => {},
			locateFile: options.locateFile,
		});
		const sqlite3 = await sqlite3Loading;
		const deadline = Date.now() + OPEN_DEADLINE_MS;
		for (;;) {
			try {
				const pool = await (sqlite3.installOpfsSAHPoolVfs as InstallPool)({
					name: `sync-engine-${options.filename}`,
					directory: `/.sync-engine/${options.filename}`,
					// On failure the pool would otherwise remove its directory, which is another worker's live database.
					preserveOnInitFailure: true,
					forceReinitIfPreviouslyFailed: true,
				});
				return attach(sqlite3, new pool.OpfsSAHPoolDb(`/${options.filename}`));
			} catch (error) {
				const held = error instanceof Error && HELD_ERRORS.has(error.name);
				if (!held) throw new SyncWebError('open-failed', message(error));
				// The previous host's access handles are released a moment after its worker dies.
				if (Date.now() > deadline) throw new SyncWebError('already-open', 'the database is open in another tab');
				await new Promise(resolve => setTimeout(resolve, OPEN_RETRY_MS));
			}
		}
	}

	function attach(sqlite3: Sqlite3Static, db: Database): Host {
		const touched = new Set<string>();
		sqlite3.capi.sqlite3_update_hook(db, (_ctx, _op, _dbName, table) => void touched.add(table), 0);
		const driver: SqlDriver = {
			exec: (sql, params = []) =>
				db.exec({
					sql,
					bind: params.length ? params : undefined,
					rowMode: 'object',
					returnValue: 'resultRows',
				}) as Row[],
			transaction: fn => db.transaction(fn),
		};
		const clientOptions: SyncClientOptions = {
			driver,
			schema: options.schema,
			endpoint: options.endpoint,
			token: token ?? undefined,
			headers: options.headers,
			interval: options.interval,
			maxBackoff: options.maxBackoff,
		};
		const client = createSyncClient(clientOptions);
		client.migrate();
		client.onChange(tables => notify([...tables]));
		client.onStatus(status => {
			const change = { kind: 'sync-status', status } satisfies Bus;
			scope.postMessage(change);
			bus.postMessage(change);
		});
		const host: Host = { kind: 'host', sqlite3, db, client, clientOptions, started: false, touched };
		if (token !== null) {
			client.start();
			host.started = true;
		}
		return host;
	}

	function notify(tables: string[]) {
		const change = { kind: 'change', tables } satisfies Bus;
		scope.postMessage(change);
		bus.postMessage(change);
	}

	function query(host: Host, sql: string, params: SqlValue[]): QueryResult {
		const columns: string[] = [];
		const rows = host.db.exec({
			sql,
			bind: params.length ? params : undefined,
			rowMode: 'array',
			returnValue: 'resultRows',
			columnNames: columns,
		});
		return { columns, rows: rows as SqlValue[][] };
	}

	function rollbackIfOpen(host: Host): boolean {
		if (host.sqlite3.capi.sqlite3_get_autocommit(host.db) !== 0) return false;
		host.db.exec('ROLLBACK');
		return true;
	}

	function afterWrite(host: Host) {
		const tables = [...host.touched].filter(table => !hidden(table));
		host.touched.clear();
		if (!tables.length) return;
		if (host.started && tables.some(table => appTables.has(table))) host.client.markDirty();
		notify(tables);
	}

	async function execute(host: Host, call: Call<HostKind>): Promise<Reply<HostKind>> {
		const { id } = call;
		try {
			switch (call.kind) {
				case 'exec': {
					host.touched.clear();
					let result: QueryResult;
					try {
						result = query(host, call.sql, call.params);
					} catch (error) {
						rollbackIfOpen(host);
						throw error;
					}
					if (rollbackIfOpen(host)) {
						throw new SyncWebError(
							'explicit-transaction',
							'BEGIN is not allowed on the shared connection; use batch() to run statements in one transaction',
						);
					}
					afterWrite(host);
					return { id, kind: 'exec', ok: true, result };
				}
				case 'batch': {
					host.touched.clear();
					const result = host.db.transaction(() =>
						call.statements.map(statement => query(host, statement.sql, statement.params ?? [])),
					);
					afterWrite(host);
					return { id, kind: 'batch', ok: true, result };
				}
				case 'sync':
					try {
						return { id, kind: 'sync', ok: true, result: await host.client.sync() };
					} catch (error) {
						return { id, kind: 'sync', ok: false, error: failure(error, 'sync') };
					}
				case 'reset':
					await host.client.reset();
					host.touched.clear();
					return { id, kind: 'reset', ok: true, result: null };
				case 'status':
					return {
						id,
						kind: 'status',
						ok: true,
						result: { ...host.client.status(), clientId: host.client.clientId(), host: true },
					};
			}
		} catch (error) {
			return { id, kind: call.kind, ok: false, error: failure(error, 'sql') };
		}
	}

	const refuse = (call: Call, error: SyncWebError): Reply => ({
		id: call.id,
		kind: call.kind,
		ok: false,
		error: failure(error, 'open-failed'),
	});

	function applyToken(next: string | null | undefined) {
		if (next === token) return;
		token = next;
		if (role.kind !== 'host') return;
		const host = role;
		host.clientOptions.token = next ?? undefined;
		if (host.started) host.client.stop();
		host.started = next !== null;
		if (host.started) host.client.start();
	}

	function closeDown() {
		if (role.kind === 'host') {
			if (role.started) role.client.stop();
			role.db.close();
		}
		released.resolve();
		bus.close();
	}

	scope.addEventListener('message', async ({ data: call }) => {
		if (call.kind === 'setToken') {
			applyToken(call.token);
			bus.postMessage({ kind: 'token', token: call.token } satisfies Bus);
			scope.postMessage({ id: call.id, kind: 'setToken', ok: true, result: null });
			return;
		}
		if (call.kind === 'close') {
			closeDown();
			scope.postMessage({ id: call.id, kind: 'close', ok: true, result: null });
			scope.close();
			return;
		}
		switch (role.kind) {
			case 'host':
				scope.postMessage(await execute(role, call));
				return;
			case 'peer':
				role.inflight.set(call.id, call);
				bus.postMessage({ kind: 'call', from, call } satisfies Bus);
				return;
			case 'opening':
				role.inflight.set(call.id, call);
				return;
			case 'failed':
				role = { kind: 'opening', inflight: new Map([[call.id, call]]) };
				void becomeHost();
		}
	});

	bus.addEventListener('message', async ({ data }: MessageEvent<Bus>) => {
		switch (data.kind) {
			case 'call':
				if (role.kind === 'host' || role.kind === 'failed') {
					const reply = role.kind === 'host' ? await execute(role, data.call) : refuse(data.call, role.error);
					bus.postMessage({ kind: 'reply', to: data.from, reply } satisfies Bus);
				}
				return;
			case 'reply': {
				if (data.to !== from || role.kind !== 'peer' || !role.inflight.delete(data.reply.id)) return;
				const { reply } = data;
				scope.postMessage(
					reply.kind === 'status' && reply.ok ? { ...reply, result: { ...reply.result, host: false } } : reply,
				);
				return;
			}
			case 'change':
			case 'sync-status':
				scope.postMessage(data);
				return;
			case 'host':
				if (role.kind === 'peer') {
					for (const call of role.inflight.values()) bus.postMessage({ kind: 'call', from, call } satisfies Bus);
				}
				return;
			case 'token':
				applyToken(data.token);
				return;
			case 'hello':
				if (role.kind === 'host') bus.postMessage({ kind: 'token', token } satisfies Bus);
		}
	});
}
