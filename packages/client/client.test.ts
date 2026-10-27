import { afterEach, describe, expect, test } from 'bun:test';
import {
	bearerToken,
	createSpace,
	defineSchema,
	type SqlDriver,
	type SyncRequest,
	type SyncResponse,
} from '../core/src/index.ts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import { serve } from '../bun-server/src/index.ts';
import { createSyncClient, type SyncClientOptions, type SyncStatus } from './src/index.ts';

const schema = defineSchema({
	tables: {
		notes: sqliteTable('notes', {
			id: text('id').primaryKey(),
			title: text('title').notNull(),
			done: integer('done').notNull().default(0),
		}),
		tags: sqliteTable('tags', { id: text('id').primaryKey(), label: text('label').notNull() }),
	},
});

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).toReversed()) fn();
});

function server(
	options: { driver?: SqlDriver; port?: number; authorize?: (request: Request) => boolean; pageSize?: number } = {},
) {
	const driver = options.driver ?? bunSqlite(':memory:');
	const instance = serve({
		driver,
		schema,
		authorize: options.authorize ?? (() => true),
		port: options.port ?? 0,
		space: { pageSize: options.pageSize },
	});
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
		expect(await changed).toEqual(new Set(['notes', 'tags']));
		expect(a.client.status()).toEqual({
			live: false,
			syncing: false,
			pending: 0,
			cursor: 2,
			lastError: null,
			snapshot: null,
			unauthorized: false,
			rejected: [],
		});

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
		expect(dump()).toEqual({ notes: expected, tags: [] });
		expect(a.rows()).toEqual(expected);
		expect(b.rows()).toEqual(expected);
	});

	test('a paged snapshot runs in one sync and reports its progress', async () => {
		const { endpoint } = server({ pageSize: 2 });
		const a = peer(endpoint);
		for (let i = 1; i <= 5; i++) insert(a.db, `n${i}`, `note ${i}`);
		await a.client.sync();

		const seen: (SyncStatus['snapshot'] | 'done')[] = [];
		const pages: (SyncRequest & { protocol: 2 })[] = [];
		const watching = (async (input: RequestInfo | URL, init?: RequestInit) => {
			pages.push(JSON.parse(String(init?.body)) as SyncRequest & { protocol: 2 });
			const response = await fetch(input, init);
			seen.push(c.client.status().snapshot ?? 'done');
			return response;
		}) as typeof fetch;
		const c = peer(endpoint, { fetch: watching });
		const changed = c.nextChange();
		const last = await c.client.sync();
		expect(pages.map(page => [page.cursor, page.after?.id ?? null, page.writes.length])).toEqual([
			[0, null, 0],
			[0, 'n2', 0],
			[0, 'n4', 0],
		]);
		expect(seen).toEqual(['done', { rows: 2 }, { rows: 4 }]);
		expect({ snapshot: last.snapshot, next: last.next, head: last.head }).toEqual({
			snapshot: true,
			next: null,
			head: 5,
		});
		expect(await changed).toEqual(new Set(['notes', 'tags']));
		expect(c.rows().map(r => r.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
		expect(c.client.status()).toEqual({
			live: false,
			syncing: false,
			pending: 0,
			cursor: 5,
			lastError: null,
			snapshot: null,
			unauthorized: false,
			rejected: [],
		});
	});

	test('a page that fails after a committed page still reports the committed tables', async () => {
		const { endpoint } = server({ pageSize: 2 });
		const a = peer(endpoint);
		insert(a.db, 'n1', 'one');
		insert(a.db, 'n2', 'two');
		a.db.exec("INSERT INTO tags (id, label) VALUES ('t1', 'red'), ('t2', 'blue')");
		await a.client.sync();

		let calls = 0;
		const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls += 1;
			if (calls === 2) throw new Error('page 2 lost');
			return fetch(input, init);
		}) as typeof fetch;
		const c = peer(endpoint, { fetch: flaky });
		await expect(c.client.sync()).rejects.toThrow('page 2 lost');
		expect(c.rows().map(r => r.id)).toEqual(['n1', 'n2']);
		expect(c.client.status().snapshot).toEqual({ rows: 2 });

		const changed = c.nextChange();
		await c.client.sync();
		expect(await changed).toEqual(new Set(['notes', 'tags']));
		expect(c.db.exec('SELECT id FROM tags ORDER BY id')).toEqual([{ id: 't1' }, { id: 't2' }]);
		expect(c.client.status().snapshot).toBeNull();
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
		expect(await changed).toEqual(new Set(['notes', 'tags']));
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
			next: null,
		});
		const queued: SyncResponse = {
			head: 2,
			acked: 2,
			rejected: [],
			snapshot: false,
			rows: [{ table: 'notes', id: 'n2', deleted: 0, values: { id: 'n2', title: 'second', done: 0 } }],
			next: null,
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
			snapshot: null,
			unauthorized: true,
			rejected: [],
		});

		const right = peer(endpoint, { token: 'secret' });
		insert(right.db, 'n2', 'sent');
		expect((await right.client.sync()).acked).toBe(1);
		expect(right.client.status().pending).toBe(0);
	});

	test('after a 401 nothing syncs on its own until start or sync', async () => {
		let requests = 0;
		const statuses: SyncStatus[] = [];
		const refused = peer('http://127.0.0.1:1', {
			token: 'expired',
			maxBackoff: 20,
			fetch: (async () => {
				requests++;
				return new Response('unauthorized', { status: 401 });
			}) as unknown as typeof fetch,
			WebSocket: class {
				static OPEN = 1;
				readyState = 0;
				addEventListener() {}
				close() {}
			} as unknown as typeof WebSocket,
		});
		refused.client.onStatus(status => statuses.push(status));
		refused.client.start();
		await until(() => requests > 0);
		insert(refused.db, 'n1', 'waits');
		refused.client.markDirty();
		await Bun.sleep(250);
		expect(requests).toBe(1);
		expect(statuses.at(-1)?.unauthorized).toBe(true);
		await expect(refused.client.sync()).rejects.toThrow('401');
		expect(requests).toBe(2);
		refused.client.start();
		await until(() => requests === 3);
	});

	test('keeps the writes the server refused, newest first', async () => {
		const reply = (rejected: SyncResponse['rejected']): SyncResponse => ({
			head: 0,
			acked: 2,
			rejected,
			snapshot: false,
			rows: [],
			next: null,
		});
		const answers = [
			reply([{ seq: 1, table: 'notes', id: 'a', reason: 'first' }]),
			reply([{ seq: 2, table: 'notes', id: 'b', reason: 'second' }]),
		];
		const client = peer('http://127.0.0.1:1', {
			fetch: (async () => Response.json(answers.shift())) as unknown as typeof fetch,
		});
		await client.client.sync();
		await client.client.sync();
		expect(client.client.status().rejected.map(r => r.reason)).toEqual(['second', 'first']);
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
		expect(await changed).toEqual(new Set(['notes', 'tags']));
		expect(b.rows()).toEqual([{ id: 'n1', title: 'after restart', done: 0 }]);
	});

	test('a write queued while the server is down lands within 3 s of its restart', async () => {
		const first = server();
		const a = peer(first.endpoint, { maxBackoff: 250 });
		a.client.start();
		await until(() => a.client.status().live && !a.client.status().syncing);

		const port = first.instance.port;
		first.instance.stop(true);
		await until(() => !a.client.status().live);
		insert(a.db, 'n1', 'queued');
		a.client.markDirty();
		await until(() => a.client.status().lastError !== null);
		await Bun.sleep(3500);

		const second = server({ driver: first.driver, port });
		const restarted = performance.now();
		await until(() => a.client.status().pending === 0, 3000);
		expect(performance.now() - restarted).toBeLessThan(3000);
		expect(second.dump()).toEqual({ notes: [{ id: 'n1', title: 'queued', done: 0 }], tags: [] });
		expect(a.client.status().lastError).toBeNull();
	}, 10_000);
});

describe('live socket that died silently', () => {
	// Sends vanish and inbound messages are withheld while `down`, and new sockets refuse to connect, while HTTP still
	// answers: the shape of an outage whose socket never reported a close, and of iOS reconnects failing after it.
	function deadSockets() {
		let down = false;
		class Dead extends WebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(down ? 'ws://127.0.0.1:1/live' : url, protocols);
			}
			override send(data: string) {
				if (!down) super.send(data);
			}
			override addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
				const gated =
					type === 'message' && typeof listener === 'function'
						? (event: Event) => {
								if (!down) listener(event);
							}
						: listener;
				super.addEventListener(type, gated);
			}
		}
		return { Socket: Dead as unknown as typeof WebSocket, cut: () => (down = true), restore: () => (down = false) };
	}

	test('a reader catches up within 4 ticks of maxBackoff while its socket stays dead', async () => {
		const { endpoint } = server();
		const sockets = deadSockets();
		const a = peer(endpoint);
		const b = peer(endpoint, { maxBackoff: 250, WebSocket: sockets.Socket });
		b.client.start();
		await until(() => b.client.status().live && !b.client.status().syncing);

		sockets.cut();
		insert(a.db, 'n1', 'while dead');
		await a.client.sync();
		const wrote = performance.now();
		await until(() => b.rows().length === 1, 1500);
		expect(performance.now() - wrote).toBeLessThan(1000);
		expect(b.client.status().live).toBe(false);

		sockets.restore();
		await until(() => b.client.status().live);
	}, 5000);
});

describe('beforePush', () => {
	test('runs before a sync that sends writes, and its throw keeps the writes for the retry', async () => {
		const { endpoint, dump } = server();
		let fail = true;
		const calls: number[] = [];
		const a = peer(endpoint, {
			beforePush: async () => {
				calls.push(Date.now());
				if (fail) throw new Error('upload the files first');
			},
		});
		await a.client.sync();
		expect(calls).toHaveLength(0);
		insert(a.db, 'n1', 'needs a file');
		await expect(a.client.sync()).rejects.toThrow('upload the files first');
		expect(a.client.status().pending).toBe(1);
		fail = false;
		await a.client.sync();
		expect(calls).toHaveLength(2);
		expect(dump().notes!.map(row => row.id)).toEqual(['n1']);
	});
});

describe('reset', () => {
	test('refuses while the loop runs, and clears the status it leaves', async () => {
		const { endpoint } = server();
		const a = peer(endpoint);
		insert(a.db, 'n1', 'one');
		await a.client.sync();
		a.client.start();
		await expect(a.client.reset()).rejects.toThrow('stop() the sync client before reset()');
		a.client.stop();
		await a.client.reset();
		expect(a.rows()).toEqual([]);
		expect(a.client.status()).toMatchObject({
			pending: 0,
			cursor: 0,
			lastError: null,
			unauthorized: false,
			rejected: [],
		});
	});
});
