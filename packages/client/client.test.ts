import { afterEach, describe, expect, test } from 'bun:test';
import { bearerToken, createSpace, defineSchema, type SqlDriver, type SyncResponse } from '@sync-engine/core';
// Relative imports: declaring these as workspace devDependencies of this package changes bun.lock.
import { integer, sqliteTable, text } from '../core/node_modules/drizzle-orm/sqlite-core';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import { serve } from '../bun-server/src/index.ts';
import { createSyncClient, type SyncClientOptions } from './src/index.ts';

const schema = defineSchema({
	tables: {
		notes: sqliteTable('notes', {
			id: text('id').primaryKey(),
			title: text('title').notNull(),
			done: integer('done').notNull().default(0),
		}),
	},
});

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).toReversed()) fn();
});

function server(options: { driver?: SqlDriver; port?: number; authorize?: (request: Request) => boolean } = {}) {
	const driver = options.driver ?? bunSqlite(':memory:');
	const instance = serve({ driver, schema, authorize: options.authorize ?? (() => true), port: options.port ?? 0 });
	cleanup.push(() => instance.stop(true));
	return {
		instance,
		driver,
		endpoint: `http://127.0.0.1:${instance.port}`,
		dump: () => createSpace(driver, schema).dump(),
	};
}

function peer(endpoint: string, extra: Partial<SyncClientOptions> = {}) {
	const db = bunSqlite(':memory:');
	const client = createSyncClient({ driver: db, schema, endpoint, ...extra });
	client.migrate();
	cleanup.push(() => client.stop());
	return {
		db,
		client,
		rows: () => db.exec('SELECT * FROM notes ORDER BY id'),
		nextChange: () =>
			new Promise<ReadonlySet<string>>(resolve => {
				const off = client.onChange(tables => {
					off();
					resolve(tables);
				});
			}),
	};
}

async function until(condition: () => boolean, timeout = 4000) {
	const deadline = performance.now() + timeout;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error('timed out waiting for condition');
		await Bun.sleep(10);
	}
}

const insert = (db: SqlDriver, id: string, title: string) =>
	db.exec('INSERT INTO notes (id, title) VALUES (?, ?)', [id, title]);

describe('createSyncClient over HTTP', () => {
	test('two clients converge through one server', async () => {
		const { endpoint, dump } = server();
		const a = peer(endpoint);
		const b = peer(endpoint);

		insert(a.db, 'n1', 'one');
		insert(a.db, 'n2', 'two');
		const changed = a.nextChange();
		a.client.markDirty();
		a.client.markDirty();
		expect(await changed).toEqual(new Set(['notes']));
		expect(a.client.status()).toEqual({ live: false, syncing: false, pending: 0, cursor: 2, lastError: null });

		await b.client.sync();
		expect(b.rows()).toEqual([
			{ id: 'n1', title: 'one', done: 0 },
			{ id: 'n2', title: 'two', done: 0 },
		]);

		b.db.exec("UPDATE notes SET done = 1 WHERE id = 'n1'");
		a.db.exec("DELETE FROM notes WHERE id = 'n2'");
		await a.client.sync();
		await b.client.sync();
		await a.client.sync();
		await b.client.sync();
		const expected = [{ id: 'n1', title: 'one', done: 1 }];
		expect(dump()).toEqual({ notes: expected });
		expect(a.rows()).toEqual(expected);
		expect(b.rows()).toEqual(expected);
	});

	test('a live nudge makes a started client pull within 2 s', async () => {
		const { endpoint } = server();
		const a = peer(endpoint);
		const b = peer(endpoint);
		b.client.start();
		await until(() => b.client.status().live && !b.client.status().syncing);

		const changed = b.nextChange();
		insert(a.db, 'n1', 'live');
		const started = performance.now();
		await a.client.sync();
		expect(await changed).toEqual(new Set(['notes']));
		expect(performance.now() - started).toBeLessThan(2000);
		expect(b.rows()).toEqual([{ id: 'n1', title: 'live', done: 0 }]);
	});

	test('overlapping sync calls run one after another and coalesce waiters', async () => {
		const { endpoint } = server();
		const calls: { start: number; end: number }[] = [];
		const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const call = { start: performance.now(), end: 0 };
			calls.push(call);
			const response = await fetch(input, init);
			const body = await response.text();
			call.end = performance.now();
			return new Response(body, response);
		}) as typeof fetch;
		const a = peer(endpoint, { fetch: recording });

		insert(a.db, 'n1', 'first');
		const resolved: string[] = [];
		const first = a.client.sync().then(response => (resolved.push('first'), response));
		insert(a.db, 'n2', 'second');
		const second = a.client.sync().then(response => (resolved.push('second'), response));
		const third = a.client.sync().then(response => (resolved.push('third'), response));
		expect(a.client.status().syncing).toBe(true);

		expect(await first).toEqual({
			head: 1,
			acked: 1,
			rejected: [],
			snapshot: true,
			rows: [{ table: 'notes', id: 'n1', deleted: 0, values: { id: 'n1', title: 'first', done: 0 } }],
		});
		const queued: SyncResponse = {
			head: 2,
			acked: 2,
			rejected: [],
			snapshot: false,
			rows: [{ table: 'notes', id: 'n2', deleted: 0, values: { id: 'n2', title: 'second', done: 0 } }],
		};
		expect(await second).toEqual(queued);
		expect(await third).toEqual(queued);
		expect(resolved).toEqual(['first', 'second', 'third']);
		expect(calls.length).toBe(2);
		expect(calls[0]!.end).toBeLessThanOrEqual(calls[1]!.start);
		expect(a.client.status().syncing).toBe(false);
	});

	test('a 401 rejects sync and keeps the outbox', async () => {
		const { endpoint } = server({ authorize: request => bearerToken(request) === 'secret' });
		const wrong = peer(endpoint, { token: 'wrong' });
		insert(wrong.db, 'n1', 'kept');

		await expect(wrong.client.sync()).rejects.toThrow('sync failed with 401: unauthorized');
		expect(wrong.client.status()).toEqual({
			live: false,
			syncing: false,
			pending: 1,
			cursor: 0,
			lastError: 'sync failed with 401: unauthorized',
		});

		const right = peer(endpoint, { token: 'secret' });
		insert(right.db, 'n2', 'sent');
		expect((await right.client.sync()).acked).toBe(1);
		expect(right.client.status().pending).toBe(0);
	});

	test('reconnects after the server restarts and receives the next nudge', async () => {
		const first = server();
		const a = peer(first.endpoint);
		const b = peer(first.endpoint);
		b.client.start();
		await until(() => b.client.status().live && !b.client.status().syncing);

		const port = first.instance.port;
		first.instance.stop(true);
		await until(() => !b.client.status().live);
		const second = server({ driver: first.driver, port });
		await until(() => b.client.status().live && !b.client.status().syncing);
		expect(second.endpoint).toBe(first.endpoint);

		const changed = b.nextChange();
		insert(a.db, 'n1', 'after restart');
		await a.client.sync();
		expect(await changed).toEqual(new Set(['notes']));
		expect(b.rows()).toEqual([{ id: 'n1', title: 'after restart', done: 0 }]);
	});
});
