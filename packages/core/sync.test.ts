import { describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import {
	createClient,
	createSpace,
	defineSchema,
	type Client,
	type PulledRow,
	type Row,
	type Schema,
	type Space,
	type SpaceHooks,
	type SpaceOptions,
	type SqlDriver,
	type SyncResponse,
	type Write,
} from './src/index.ts';

const notes = sqliteTable('notes', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body').notNull().default(''),
	done: integer('done', { mode: 'boolean' }).notNull().default(false),
	tags: text('tags', { mode: 'json' }).notNull().default([]),
});
const schema = defineSchema({ tables: { notes }, values: { notes: { tags: z.array(z.string()) } } });

function syncPages(server: Space, client: Client, batch = client.collect()): SyncResponse {
	let response: SyncResponse;
	let more: boolean;
	do {
		response = server.sync(client.request(batch.writes));
		({ more } = client.apply(response, batch.acked));
		batch = { writes: [], acked: 0 };
	} while (more);
	return response;
}

function setup(s: Schema = schema, options: SpaceOptions = {}) {
	const serverDb = bunSqlite(':memory:');
	const server = createSpace(serverDb, s, options);
	server.migrate();
	const peer = () => {
		const db = bunSqlite(':memory:');
		const client = createClient(db, s);
		client.migrate();
		return {
			db,
			client,
			sync: () => syncPages(server, client),
			pull: () => syncPages(server, client, { writes: [], acked: 0 }),
			rows: () => db.exec('SELECT * FROM notes ORDER BY id'),
		};
	};
	return { serverDb, server, a: peer(), b: peer() };
}
type Peer = ReturnType<typeof setup>['a'];

const insert = (peer: Peer, id: string, title: string) =>
	peer.db.exec('INSERT INTO notes (id, title) VALUES (?, ?)', [id, title]);
const update = (peer: Peer, id: string, column: string, value: string | number) =>
	peer.db.exec(`UPDATE notes SET ${column} = ? WHERE id = ?`, [value, id]);
const columns = (driver: SqlDriver) => driver.exec('PRAGMA table_info(notes)').map(c => c.name);
const put = (seq: number, table: string, id: string, values: Record<string, string>): Write => ({
	seq,
	table,
	id,
	op: 'put',
	values,
});
const row = (id: string, title: string, rest: Record<string, string | number> = {}) => ({
	id,
	title,
	body: '',
	done: 0,
	tags: '[]',
	...rest,
});

describe('two clients and one space', () => {
	test('converge after each syncs twice', () => {
		const { server, a, b } = setup();
		insert(a, 'n1', 'from a');
		insert(b, 'n2', 'from b');
		a.sync();
		b.sync();
		a.sync();
		const both = [row('n1', 'from a'), row('n2', 'from b')];
		expect(server.dump()).toEqual({ notes: both });
		expect(a.rows()).toEqual(both);
		expect(b.rows()).toEqual(both);
	});

	test('column-level last write wins', () => {
		const { server, a, b } = setup();
		insert(a, 'n1', 'original');
		a.sync();
		b.sync();
		update(a, 'n1', 'title', 'A title');
		update(b, 'n1', 'body', 'B body');
		a.sync();
		b.sync();
		a.sync();
		expect(a.rows()).toEqual([row('n1', 'A title', { body: 'B body' })]);
		expect(b.rows()).toEqual(a.rows());
		update(a, 'n1', 'title', 'A again');
		update(b, 'n1', 'title', 'B arrives later');
		a.sync();
		b.sync();
		a.sync();
		expect(server.dump().notes![0]!.title).toBe('B arrives later');
		expect(a.rows()[0]!.title).toBe('B arrives later');
	});

	test('delete beats a later patch', () => {
		const { server, a, b } = setup();
		insert(a, 'n1', 'doomed');
		a.sync();
		b.sync();
		a.db.exec("DELETE FROM notes WHERE id = 'n1'");
		update(b, 'n1', 'title', 'edited offline');
		a.sync();
		const response = b.sync();
		expect(response.rows).toEqual([{ table: 'notes', id: 'n1', deleted: 1 }]);
		expect(server.dump()).toEqual({ notes: [] });
		expect(b.rows()).toEqual([]);
		expect(server.head()).toBe(2);
	});

	test('a replayed batch applies once', () => {
		const { server, a } = setup();
		insert(a, 'n1', 'once');
		const { writes } = a.client.collect();
		const request = { protocol: 1 as const, client: a.client.clientId(), cursor: 0, writes };
		const first = server.sync(request);
		const second = server.sync(request);
		expect(first).toEqual({
			head: 1,
			acked: 1,
			rejected: [],
			snapshot: true,
			rows: [{ table: 'notes', id: 'n1', deleted: 0, values: row('n1', 'once') }],
		});
		expect(second).toEqual(first);
		expect(server.head()).toBe(1);
	});

	test('a rejected write is dropped and the server row comes back', () => {
		const { a } = setup();
		insert(a, 'n1', 'tagged');
		a.sync();
		update(a, 'n1', 'tags', '[1]');
		const response = a.sync();
		expect(response.rejected).toEqual([{ seq: 2, table: 'notes', id: 'n1', reason: expect.any(String) }]);
		expect(response.rows).toEqual([{ table: 'notes', id: 'n1', deleted: 0, values: row('n1', 'tagged') }]);
		expect(a.rows()).toEqual([row('n1', 'tagged')]);
		expect(a.client.pending()).toBe(0);
	});

	test('an id validator runs against the write id', () => {
		const items = sqliteTable('items', { id: text('id').primaryKey(), name: text('name').notNull() });
		const { server } = setup(
			defineSchema({
				tables: { items },
				values: { items: { id: z.string().startsWith('custom-', 'needs a custom- prefix') } },
			}),
		);
		const sync = (seq: number, id: string) =>
			server.sync({ protocol: 1, client: 'c', cursor: 0, writes: [put(seq, 'items', id, { name: 'x' })] });
		expect(sync(1, 'x1').rejected).toEqual([
			{ seq: 1, table: 'items', id: 'x1', reason: 'id: needs a custom- prefix' },
		]);
		expect(sync(2, 'custom-x1').rejected).toEqual([]);
		expect(server.dump()).toEqual({ items: [{ id: 'custom-x1', name: 'x' }] });
	});

	test('cursor 0 gets a snapshot and the triggers stay quiet while applying', () => {
		const { a, b } = setup();
		insert(a, 'n1', 'one');
		insert(a, 'n2', 'two');
		a.sync();
		a.db.exec("DELETE FROM notes WHERE id = 'n2'");
		a.sync();
		const response = b.sync();
		expect(response.snapshot).toBe(true);
		expect(response.rows).toEqual([{ table: 'notes', id: 'n1', deleted: 0, values: row('n1', 'one') }]);
		expect(b.rows()).toEqual([row('n1', 'one')]);
		expect(b.client.pending()).toBe(0);
		expect(b.client.cursor()).toBe(3);
	});

	test('a pending local edit survives a pull and the next sync pushes it', () => {
		const { server, a, b } = setup();
		insert(a, 'n1', 'shared');
		a.sync();
		b.sync();
		update(b, 'n1', 'title', 'remote title');
		b.sync();
		update(a, 'n1', 'body', 'local body');
		a.pull();
		expect(a.rows()).toEqual([row('n1', 'shared', { body: 'local body' })]);
		expect(a.client.pending()).toBe(1);
		a.sync();
		expect(server.dump()).toEqual({ notes: [row('n1', 'remote title', { body: 'local body' })] });
		expect(a.rows()).toEqual(server.dump().notes!);
	});

	test('an additive migration adds a column on both sides', () => {
		const v1 = setup();
		insert(v1.a, 'n1', 'old');
		v1.a.sync();
		const v2 = defineSchema({
			tables: {
				notes: sqliteTable('notes', {
					id: text('id').primaryKey(),
					title: text('title').notNull(),
					body: text('body').notNull().default(''),
					done: integer('done', { mode: 'boolean' }).notNull().default(false),
					tags: text('tags', { mode: 'json' }).notNull().default([]),
					priority: integer('priority').notNull().default(0),
				}),
			},
		});
		const server = createSpace(v1.serverDb, v2);
		server.migrate();
		const client = createClient(v1.a.db, v2);
		client.migrate();
		expect(columns(v1.serverDb)).toEqual(['id', 'title', 'body', 'done', 'tags', 'priority']);
		expect(columns(v1.a.db)).toEqual(columns(v1.serverDb));
		expect(v1.a.rows()).toEqual([row('n1', 'old', { priority: 0 })]);
		update(v1.a, 'n1', 'priority', 5);
		const { writes, acked } = client.collect();
		expect(writes).toEqual([{ seq: 2, table: 'notes', id: 'n1', op: 'patch', values: { priority: 5 } }]);
		client.apply(server.sync({ protocol: 1, client: client.clientId(), cursor: client.cursor(), writes }), acked);
		expect(server.dump()).toEqual({ notes: [row('n1', 'old', { priority: 5 })] });
		const required = defineSchema({
			tables: { notes: sqliteTable('notes', { id: text('id').primaryKey(), owner: text('owner').notNull() }) },
		});
		expect(() => createSpace(v1.serverDb, required).migrate()).toThrow();
	});

	test('a client that gains a column or a table re-pulls the values other devices set before it upgraded', () => {
		const v1 = setup();
		insert(v1.a, 'n1', 'old');
		v1.a.sync();
		v1.b.pull();
		const labels = sqliteTable('labels', { id: text('id').primaryKey(), name: text('name').notNull() });
		const v2 = defineSchema({
			tables: {
				notes: sqliteTable('notes', {
					id: text('id').primaryKey(),
					title: text('title').notNull(),
					body: text('body').notNull().default(''),
					done: integer('done', { mode: 'boolean' }).notNull().default(false),
					tags: text('tags', { mode: 'json' }).notNull().default([]),
					priority: integer('priority').notNull().default(0),
				}),
				labels,
			},
		});
		const server = createSpace(v1.serverDb, v2);
		server.migrate();
		const a = createClient(v1.a.db, v2);
		a.migrate();
		update(v1.a, 'n1', 'priority', 5);
		v1.a.db.exec("INSERT INTO labels (id, name) VALUES ('l1', 'home')");
		syncPages(server, a);
		syncPages(server, v1.b.client);
		expect(v1.b.client.cursor()).toBe(a.cursor());
		insert(v1.b, 'n2', 'pending');
		const b = createClient(v1.b.db, v2);
		b.migrate();
		syncPages(server, b);
		expect(v1.b.rows()).toEqual([row('n1', 'old', { priority: 5 }), row('n2', 'pending', { priority: 0 })]);
		expect(v1.b.db.exec('SELECT id, name FROM labels')).toEqual([{ id: 'l1', name: 'home' }]);
		expect(server.dump().notes).toEqual([row('n1', 'old', { priority: 5 }), row('n2', 'pending', { priority: 0 })]);
		const head = b.cursor();
		b.migrate();
		expect(b.cursor()).toBe(head);
	});
});

describe('protocol amendments', () => {
	test('a put over an existing row is an upsert, so a cascading child survives', () => {
		const parents = sqliteTable('parents', { id: text('id').primaryKey(), name: text('name').notNull() });
		const children = sqliteTable('children', { id: text('id').primaryKey(), parent_id: text('parent_id').notNull() });
		const s = defineSchema({ tables: { parents, children } });
		const fkDdl = [
			'PRAGMA foreign_keys = ON',
			'CREATE TABLE parents (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
			'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE)',
		];
		const serverDb = bunSqlite(':memory:');
		for (const sql of fkDdl) serverDb.exec(sql);
		const server = createSpace(serverDb, s);
		server.migrate();
		server.sync({
			protocol: 1,
			client: 'w',
			cursor: 0,
			writes: [
				put(1, 'parents', 'p', { name: 'v1' }),
				put(2, 'children', 'c', { parent_id: 'p' }),
				put(3, 'parents', 'p', { name: 'v2' }),
			],
		});
		expect(server.dump()).toEqual({ parents: [{ id: 'p', name: 'v2' }], children: [{ id: 'c', parent_id: 'p' }] });

		const clientDb = bunSqlite(':memory:');
		for (const sql of fkDdl) clientDb.exec(sql);
		const client = createClient(clientDb, s);
		client.migrate();
		client.apply(server.sync({ protocol: 1, client: 'r', cursor: 0, writes: [] }), 0);
		client.apply(server.sync({ protocol: 1, client: 'r', cursor: 0, writes: [] }), 0);
		expect(clientDb.exec('SELECT * FROM children')).toEqual([{ id: 'c', parent_id: 'p' }]);
	});

	test('a put or patch whose local row is gone is dropped, not turned into a delete', () => {
		const { server, a } = setup();
		insert(a, 'n1', 'ghost');
		a.db.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 1)");
		a.db.exec("DELETE FROM notes WHERE id = 'n1'");
		a.db.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 0)");
		expect(a.client.collect()).toEqual({ writes: [], acked: 1 });
		a.sync();
		expect(a.client.pending()).toBe(0);
		expect(server.dump()).toEqual({ notes: [] });
		expect(server.head()).toBe(0);
	});

	test('a snapshot keeps the locally pending row and the next sync pushes it', () => {
		const { server, a, b } = setup();
		insert(a, 'n1', 'on server');
		a.sync();
		insert(b, 'n9', 'offline on b');
		const response = b.pull();
		expect(response.snapshot).toBe(true);
		expect(b.rows()).toEqual([row('n1', 'on server'), row('n9', 'offline on b')]);
		expect(b.client.pending()).toBe(1);
		b.sync();
		expect(server.dump()).toEqual({ notes: [row('n1', 'on server'), row('n9', 'offline on b')] });
	});

	test('a rejected write returns the server row below the cursor, and acked is the stored max', () => {
		const { server, a } = setup();
		insert(a, 'n1', 'kept');
		a.sync();
		const cursor = a.client.cursor();
		const response = server.sync({
			protocol: 1,
			client: a.client.clientId(),
			cursor,
			writes: [{ seq: 2, table: 'notes', id: 'n1', op: 'patch', values: { title: 42 } }],
		});
		expect(response).toEqual({
			head: 1,
			acked: 2,
			rejected: [{ seq: 2, table: 'notes', id: 'n1', reason: expect.any(String) }],
			snapshot: false,
			rows: [{ table: 'notes', id: 'n1', deleted: 0, values: row('n1', 'kept') }],
		});
		const high = server.sync({
			protocol: 1,
			client: 'x',
			cursor: 1,
			writes: [{ seq: 5, table: 'notes', id: 'n2', op: 'delete' }],
		});
		const low = server.sync({
			protocol: 1,
			client: 'x',
			cursor: 2,
			writes: [{ seq: 2, table: 'notes', id: 'n3', op: 'delete' }],
		});
		expect([high.acked, high.head, low.acked, low.head]).toEqual([5, 2, 5, 2]);
	});

	test('interleaved edits give a batch out of seq order and every write still applies', () => {
		const { server, a, b } = setup();
		insert(a, 'n1', 'A');
		insert(a, 'n2', 'B');
		update(a, 'n1', 'title', 'A2');
		expect(a.client.collect().writes.map(w => w.seq)).toEqual([3, 2]);
		const response = a.sync();
		expect(response.acked).toBe(3);
		expect(server.dump().notes).toEqual([row('n1', 'A2'), row('n2', 'B')]);
		expect(a.client.pending()).toBe(0);
		b.sync();
		expect(b.rows()).toEqual([row('n1', 'A2'), row('n2', 'B')]);
	});

	test('a rejected insert the server never stored comes back as a tombstone', () => {
		const { a } = setup();
		insert(a, 'n1', 'first');
		a.sync();
		a.db.exec("INSERT INTO notes (id, title, tags) VALUES ('n2', 'bad', '[1]')");
		const response = a.sync();
		expect(response.rejected.map(r => r.id)).toEqual(['n2']);
		expect(response.rows).toEqual([{ table: 'notes', id: 'n2', deleted: 1 }]);
		expect(a.rows()).toEqual([row('n1', 'first')]);
	});

	test('an explicit null from the server stays null, the default fills only an absent column', () => {
		const drafts = sqliteTable('drafts', {
			id: text('id').primaryKey(),
			body: text('body').default('fallback'),
		});
		const { a, b } = setup(defineSchema({ tables: { drafts } }));
		a.db.exec("INSERT INTO drafts (id, body) VALUES ('d1', NULL)");
		a.sync();
		b.pull();
		expect(b.db.exec('SELECT * FROM drafts')).toEqual([{ id: 'd1', body: null }]);
	});

	test('the echo of a pushed write touches no table, a changed or deleted row does', () => {
		const { server, a, b } = setup();
		const sync = (peer: Peer) => {
			const batch = peer.client.collect();
			const response = server.sync({
				protocol: 2,
				client: peer.client.clientId(),
				cursor: peer.client.cursor(),
				writes: batch.writes,
			});
			return { rows: response.rows.map(r => r.id), touched: [...peer.client.apply(response, batch.acked).tables] };
		};
		insert(b, 'n1', 'from b');
		b.sync();
		a.pull();
		insert(a, 'n2', 'from a');
		expect(sync(a)).toEqual({ rows: ['n2'], touched: [] });
		b.pull();
		update(b, 'n2', 'title', 'b edit');
		b.sync();
		expect(sync(a)).toEqual({ rows: ['n2'], touched: ['notes'] });
		a.db.exec("DELETE FROM notes WHERE id = 'n2'");
		expect(sync(a)).toEqual({ rows: ['n2'], touched: [] });
		b.db.exec("DELETE FROM notes WHERE id = 'n1'");
		b.sync();
		expect(sync(a)).toEqual({ rows: ['n1'], touched: ['notes'] });
		expect(a.rows()).toEqual([]);
	});

	test('a copied database mints a new client id and re-sends its outbox', () => {
		const { server, a, b } = setup();
		for (let i = 1; i <= 5; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		b.db.exec("UPDATE _meta SET value = ? WHERE key = 'client'", [a.client.clientId()]);
		insert(b, 'n6', 'six');
		insert(b, 'n7', 'seven');
		expect(b.client.collect().acked).toBe(2);
		const skipped = b.sync();
		expect(skipped.acked).toBe(5);
		expect(b.client.clientId()).not.toBe(a.client.clientId());
		expect(b.client.pending()).toBe(2);
		expect(b.client.cursor()).toBe(0);
		expect(b.rows()).toEqual([row('n6', 'six'), row('n7', 'seven')]);
		b.sync();
		expect(b.client.pending()).toBe(0);
		expect(server.dump().notes!.map(r => r.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
		expect(b.rows()).toHaveLength(7);
	});
});

describe('protocol 2', () => {
	const ids = (response: SyncResponse) => response.rows.map(r => r.id);

	test('a cursor behind the compaction horizon gets a snapshot that converges, and one at the horizon a delta', () => {
		let clock = 1000;
		const { server, a, b } = setup(schema, { now: () => clock, retention: 100, compactEvery: 10 });
		insert(a, 'n1', 'one');
		insert(a, 'n2', 'two');
		a.sync();
		b.sync();
		a.db.exec("DELETE FROM notes WHERE id = 'n1'");
		a.sync();
		clock = 1200;
		insert(a, 'n3', 'three');
		a.sync();
		expect(server.compact()).toBe(3);

		expect(b.client.cursor()).toBe(2);
		const response = b.sync();
		expect(response).toEqual({
			space: server.space(),
			head: 4,
			acked: 0,
			rejected: [],
			snapshot: true,
			rows: [
				{ table: 'notes', id: 'n2', deleted: 0, values: row('n2', 'two') },
				{ table: 'notes', id: 'n3', deleted: 0, values: row('n3', 'three') },
			],
			next: null,
		});
		expect(b.rows()).toEqual([row('n2', 'two'), row('n3', 'three')]);
		expect(b.client.cursor()).toBe(4);

		const atHorizon = server.sync({ protocol: 2, client: 'x', cursor: 3, writes: [] });
		expect({ snapshot: atHorizon.snapshot, ids: ids(atHorizon) }).toEqual({ snapshot: false, ids: ['n3'] });
	});

	test('a pageSize-2 snapshot over 7 rows converges, with a write between pages and a crash between pages', () => {
		const { server, a, b } = setup(schema, { pageSize: 2 });
		for (let i = 1; i <= 7; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		expect(a.rows()).toHaveLength(7);

		const request = (after?: { table: string; id: string }) =>
			server.sync({ protocol: 2, client: b.client.clientId(), cursor: 0, writes: [], ...(after ? { after } : {}) });
		const page1 = request();
		expect(page1).toEqual({
			space: server.space(),
			head: 7,
			acked: 0,
			rejected: [],
			snapshot: true,
			rows: [
				{ table: 'notes', id: 'n1', deleted: 0, values: row('n1', 'note 1') },
				{ table: 'notes', id: 'n2', deleted: 0, values: row('n2', 'note 2') },
			],
			next: { table: 'notes', id: 'n2' },
		});
		b.client.apply(page1, 0);
		expect(b.client.snapshot()).toEqual({ after: { table: 'notes', id: 'n2' }, head: 7 });
		expect(b.client.cursor()).toBe(0);

		update(a, 'n1', 'title', 'changed between pages');
		a.sync();
		const page2 = request({ table: 'notes', id: 'n2' });
		expect({ head: page2.head, ids: ids(page2), next: page2.next }).toEqual({
			head: 8,
			ids: ['n3', 'n4'],
			next: { table: 'notes', id: 'n4' },
		});
		b.client.apply(page2, 0);

		const resumed = createClient(b.db, schema);
		resumed.migrate();
		expect(resumed.snapshot()).toEqual({ after: { table: 'notes', id: 'n4' }, head: 7 });
		const last = syncPages(server, resumed, { writes: [], acked: 0 });
		expect({ ids: ids(last), next: last.next }).toEqual({ ids: ['n7'], next: null });
		expect(resumed.snapshot()).toBeNull();
		expect(resumed.cursor()).toBe(7);
		expect(b.rows().map(r => [r.id, r.title])).toEqual([
			['n1', 'note 1'],
			['n2', 'note 2'],
			['n3', 'note 3'],
			['n4', 'note 4'],
			['n5', 'note 5'],
			['n6', 'note 6'],
			['n7', 'note 7'],
		]);

		const delta = b.pull();
		expect({ snapshot: delta.snapshot, ids: ids(delta), head: delta.head }).toEqual({
			snapshot: false,
			ids: ['n1'],
			head: 8,
		});
		expect(b.rows()).toEqual(server.dump().notes!);
		expect(b.client.cursor()).toBe(8);
	});

	test('a pending local row survives a paged snapshot that would overwrite it', () => {
		const { server, a, b } = setup(schema, { pageSize: 2 });
		for (let i = 1; i <= 3; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		insert(b, 'n2', 'offline on b');
		b.pull();
		expect(b.rows().map(r => [r.id, r.title])).toEqual([
			['n1', 'note 1'],
			['n2', 'offline on b'],
			['n3', 'note 3'],
		]);
		b.sync();
		expect(server.dump().notes!.map(r => r.title)).toEqual(['note 1', 'offline on b', 'note 3']);
	});

	test('a protocol 1 request gets an unpaged snapshot and no next', () => {
		const { server, a } = setup(schema, { pageSize: 2 });
		for (let i = 1; i <= 3; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		const response = server.sync({ protocol: 1, client: 'v1', cursor: 0, writes: [] });
		expect(response).toEqual({
			head: 3,
			acked: 0,
			rejected: [],
			snapshot: true,
			rows: [
				{ table: 'notes', id: 'n1', deleted: 0, values: row('n1', 'note 1') },
				{ table: 'notes', id: 'n2', deleted: 0, values: row('n2', 'note 2') },
				{ table: 'notes', id: 'n3', deleted: 0, values: row('n3', 'note 3') },
			],
		});
		expect('next' in response).toBe(false);
	});

	test('a page crosses a table boundary in schema order', () => {
		const items = sqliteTable('items', { id: text('id').primaryKey(), name: text('name').notNull() });
		const s = defineSchema({ tables: { notes, items } });
		const { server } = setup(s, { pageSize: 2 });
		server.sync({
			protocol: 1,
			client: 'w',
			cursor: 0,
			writes: [
				put(1, 'items', 'i1', { name: 'first item' }),
				put(2, 'notes', 'n1', { title: 'first note' }),
				put(3, 'items', 'i2', { name: 'second item' }),
			],
		});
		const page1 = server.sync({ protocol: 2, client: 'r', cursor: 0, writes: [] });
		expect({ keys: page1.rows.map(r => `${r.table}/${r.id}`), next: page1.next }).toEqual({
			keys: ['notes/n1', 'items/i1'],
			next: { table: 'items', id: 'i1' },
		});
		const page2 = server.sync({ protocol: 2, client: 'r', cursor: 0, writes: [], after: page1.next! });
		expect({ keys: page2.rows.map(r => `${r.table}/${r.id}`), next: page2.next }).toEqual({
			keys: ['items/i2'],
			next: null,
		});
	});
});

/** Applies one response at a time, so a test can look between pages. */
function step(server: Space, client: Client, batch = { writes: [] as Write[], acked: 0 }) {
	const request = client.request(batch.writes);
	const response = server.sync(request);
	const applied = client.apply(response, batch.acked);
	return { request, response, touched: [...applied.tables], more: applied.more };
}

describe('a snapshot keeps what it does not change', () => {
	/** `b` holds n1 to n5 at a cursor compaction has passed, so its next pull is a snapshot in pages of two. */
	function behindTheHorizon(drop: (a: Peer) => void) {
		let clock = 1000;
		const peers = setup(schema, { pageSize: 2, now: () => clock, retention: 100, compactEvery: 10 });
		const { server, a, b } = peers;
		for (let i = 1; i <= 5; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		b.pull();
		drop(a);
		a.sync();
		clock = 1200;
		server.compact();
		return peers;
	}
	const noteIds = (peer: Peer) => peer.rows().map(r => r.id);

	test('a snapshot of rows the client already holds changes no table, on any page', () => {
		const { server, b } = behindTheHorizon(a => {
			insert(a, 'n9', 'never reached b');
			a.db.exec("DELETE FROM notes WHERE id = 'n9'");
		});
		const before = b.rows();
		const pages = [step(server, b.client), step(server, b.client), step(server, b.client)];
		expect(pages.map(page => [page.response.snapshot, page.touched, page.more])).toEqual([
			[true, [], true],
			[true, [], true],
			[true, [], false],
		]);
		expect(b.rows()).toEqual(before);
		expect(b.client.cursor()).toBe(server.head());
	});

	test('rows the server dropped go only when the last page lands, and a row with a pending write stays', () => {
		const { server, b } = behindTheHorizon(a => a.db.exec("DELETE FROM notes WHERE id IN ('n1', 'n4')"));
		insert(b, 'n0', 'offline on b');
		update(b, 'n4', 'title', 'edited offline on b');

		expect(step(server, b.client).touched).toEqual([]);
		expect(noteIds(b)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
		const last = step(server, b.client);
		expect({ more: last.more, touched: last.touched }).toEqual({ more: false, touched: ['notes'] });
		expect(noteIds(b)).toEqual(['n0', 'n2', 'n3', 'n4', 'n5']);

		b.sync();
		expect(noteIds(b)).toEqual(['n0', 'n2', 'n3', 'n5']);
		expect(b.rows()).toEqual(server.dump().notes!);
	});

	test('a row pushed while a snapshot is paging stays when its last page lands', () => {
		const { server, a, b } = setup(schema, { pageSize: 2 });
		for (let i = 3; i <= 6; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		expect(step(server, b.client).request).toMatchObject({ cursor: 0 });
		expect(b.client.snapshot()?.after).toEqual({ table: 'notes', id: 'n4' });

		insert(b, 'n1', 'sorts before the pages already taken');
		syncPages(server, b.client);
		expect(noteIds(b)).toEqual(['n1', 'n3', 'n4', 'n5', 'n6']);
		expect(server.dump().notes!.map(r => r.id)).toEqual(['n1', 'n3', 'n4', 'n5', 'n6']);
	});

	test('a put that landed in a lost response and was deleted by another device goes with the snapshot', () => {
		const { server, a, b } = setup();
		insert(b, 'n1', 'lands, but b never hears');
		const batch = b.client.collect();
		server.sync(b.client.request(batch.writes));
		a.pull();
		a.db.exec("DELETE FROM notes WHERE id = 'n1'");
		a.sync();

		// A server from before replays were answered with a row acks the retry and says nothing about n1.
		const retry = { ...server.sync(b.client.request(batch.writes)), rows: [] };
		expect({ snapshot: retry.snapshot, acked: retry.acked }).toEqual({ snapshot: true, acked: 1 });
		b.client.apply(retry, batch.acked);
		expect(b.rows()).toEqual([]);
		expect(b.client.pending()).toBe(0);
	});

	test('an edit of a row the server dropped is undone even when the response that said so was lost', () => {
		const { server, b } = behindTheHorizon(a => a.db.exec("DELETE FROM notes WHERE id = 'n4'"));
		update(b, 'n4', 'title', 'edited while the snapshot still showed it');
		b.pull();
		expect(noteIds(b)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);

		const lost = server.sync(b.client.request(b.client.collect().writes));
		expect(lost.rows).toEqual([{ table: 'notes', id: 'n4', deleted: 1 }]);
		const retry = b.sync();
		expect({ acked: retry.acked, rows: retry.rows }).toEqual({ acked: lost.acked, rows: lost.rows });
		expect(b.rows()).toEqual(server.dump().notes!);
	});

	test('pages another engine version applied are not trusted: the snapshot starts over', () => {
		const { server, a, b } = setup(schema, { pageSize: 2 });
		for (let i = 1; i <= 5; i++) insert(a, `n${i}`, `note ${i}`);
		a.sync();
		step(server, b.client);
		// What a build from before `_seen` leaves after it applied the next page: `after` moved, `_seen` did not.
		b.db.exec(`UPDATE _meta SET value = '{"table":"notes","id":"n4"}' WHERE key = 'after'`);

		const updated = createClient(b.db, schema);
		updated.migrate();
		expect(updated.request([])).toMatchObject({ cursor: 0 });
		expect(updated.snapshot()).toBeNull();
		syncPages(server, updated);
		expect(noteIds(b)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
	});
});

describe('refresh', () => {
	const labelColumns = { id: text('id').primaryKey(), name: text('name').notNull() };
	const before = defineSchema({ tables: { notes, labels: sqliteTable('labels', labelColumns) } });
	const after = defineSchema({
		tables: {
			notes,
			labels: sqliteTable('labels', { ...labelColumns, color: text('color') }),
			items: sqliteTable('items', { id: text('id').primaryKey(), name: text('name').notNull() }),
		},
	});
	const keys = (response: SyncResponse) => response.rows.map(r => `${r.table}/${r.id}`);

	/**
	 * `b` synced under the schema before `labels` gained `color` and `items` existed, pulled past the values `a` set in
	 * them, and has just migrated to the schema that has both.
	 */
	function grown(options: SpaceOptions = {}) {
		const old = setup(before, options);
		for (let i = 1; i <= 3; i++) insert(old.a, `n${i}`, `note ${i}`);
		old.a.db.exec("INSERT INTO labels (id, name) VALUES ('l1', 'home'), ('l2', 'work'), ('l3', 'idea')");
		old.a.sync();
		old.b.pull();

		const server = createSpace(old.serverDb, after, options);
		server.migrate();
		const a = createClient(old.a.db, after);
		a.migrate();
		old.a.db.exec("UPDATE labels SET color = 'red' WHERE id = 'l1'");
		old.a.db.exec("INSERT INTO items (id, name) VALUES ('i1', 'lamp')");
		syncPages(server, a);
		syncPages(server, old.b.client);

		const b = createClient(old.b.db, after);
		b.migrate();
		const local = (): Record<string, Row[]> => ({
			notes: old.b.db.exec('SELECT * FROM notes ORDER BY id'),
			labels: old.b.db.exec('SELECT * FROM labels ORDER BY id'),
			items: old.b.db.exec('SELECT * FROM items ORDER BY id'),
		});
		return { server, a: { ...old.a, client: a }, b: { db: old.b.db, client: b, local } };
	}

	test('a client whose schema grew pulls the grown tables whole, across a restart, then the rest as a delta', () => {
		const { server, a, b } = grown({ pageSize: 2 });
		const cursor = b.client.cursor();
		expect(cursor).toBeGreaterThan(0);
		expect(b.client.refresh()).toEqual({ tables: ['labels', 'items'] });
		update(a, 'n2', 'title', 'edited after b last pulled');
		syncPages(server, a.client);

		const first = step(server, b.client);
		const restarted = createClient(b.db, after);
		restarted.migrate();
		const rest = [step(server, restarted), step(server, restarted)];
		expect(
			[first, ...rest].map(({ request, response, more }) => ({
				cursor: request.cursor,
				asked: request.refresh ?? null,
				tables: response.tables ?? null,
				rows: keys(response),
				more,
			})),
		).toEqual([
			{
				cursor,
				asked: { tables: ['labels', 'items'] },
				tables: ['labels', 'items'],
				rows: ['labels/l1', 'labels/l2'],
				more: true,
			},
			{
				cursor,
				asked: { tables: ['labels', 'items'], after: { table: 'labels', id: 'l2' } },
				tables: ['labels', 'items'],
				rows: ['labels/l3', 'items/i1'],
				more: true,
			},
			{ cursor, asked: null, tables: null, rows: ['notes/n2'], more: false },
		]);
		expect(b.local()).toEqual(server.dump());
		expect(restarted.cursor()).toBe(server.head());
		expect(restarted.refresh()).toBeNull();
	});

	test('a server older than refresh answers a delta, and the client takes a full snapshot instead', () => {
		const { server, b } = grown();
		const kinds: boolean[] = [];
		let more = true;
		while (more) {
			// A server from before refresh drops the request's `refresh` as an unknown key.
			const { refresh: _dropped, ...request } = b.client.request([]);
			const response = server.sync(request);
			kinds.push(response.snapshot);
			({ more } = b.client.apply(response, 0));
		}
		expect(kinds).toEqual([false, true]);
		expect(b.local()).toEqual(server.dump());
		expect(b.client.refresh()).toBeNull();
		expect(b.client.cursor()).toBe(server.head());
	});

	test('a refresh whose cursor another engine version moved starts its pages over', () => {
		const { server, b } = grown({ pageSize: 2 });
		step(server, b.client);
		expect(b.client.refresh()).toMatchObject({ after: { table: 'labels', id: 'l2' } });
		// A build from before refresh ignores `_meta.refresh` and pulls a delta, which moves the cursor.
		b.db.exec("UPDATE _meta SET value = value + 1 WHERE key = 'cursor'");

		const updated = createClient(b.db, after);
		updated.migrate();
		expect(updated.refresh()).toEqual({ tables: ['labels', 'items'] });
	});

	test('a refresh holds only the named tables the server has', () => {
		const { server, b } = grown();
		const response = server.sync({ ...b.client.request([]), refresh: { tables: ['unknown', 'items', 'labels'] } });
		expect({ snapshot: response.snapshot, tables: response.tables, rows: keys(response), next: response.next }).toEqual(
			{
				snapshot: true,
				tables: ['labels', 'items'],
				rows: ['labels/l1', 'labels/l2', 'labels/l3', 'items/i1'],
				next: null,
			},
		);
	});

	test('a cursor that needs a full snapshot gets it from the first page, whatever refresh it asks for', () => {
		let clock = 1000;
		const { server, a, b } = grown({ pageSize: 2, now: () => clock, retention: 100, compactEvery: 10 });
		expect(step(server, b.client).response.tables).toEqual(['labels', 'items']);
		a.db.exec("DELETE FROM notes WHERE id = 'n1'");
		syncPages(server, a.client);
		clock = 1200;
		server.compact();

		const page = step(server, b.client);
		expect(page.request).toMatchObject({ refresh: { after: { table: 'labels', id: 'l2' } } });
		expect({ tables: page.response.tables, rows: keys(page.response) }).toEqual({
			tables: undefined,
			rows: ['notes/n2', 'notes/n3'],
		});
		expect(b.client.refresh()).toBeNull();
		syncPages(server, b.client, { writes: [], acked: 0 });
		expect(b.local()).toEqual(server.dump());
	});

	test('the last page of a refresh removes the rows its tables no longer hold and leaves every other table alone', () => {
		const { server, b } = grown();
		const cursor = b.client.cursor();
		const { tables, more } = b.client.apply(
			{
				head: server.head() + 5,
				acked: 0,
				rejected: [],
				snapshot: true,
				tables: ['labels'],
				rows: [{ table: 'labels', id: 'l2', deleted: 0, values: { id: 'l2', name: 'work', color: null } }],
				next: null,
				space: server.space(),
			},
			0,
		);
		expect({ tables: [...tables], more }).toEqual({ tables: ['labels'], more: true });
		expect(b.local().labels!.map(r => r.id)).toEqual(['l2']);
		expect(b.local().notes!.map(r => r.id)).toEqual(['n1', 'n2', 'n3']);
		expect(b.client.cursor()).toBe(cursor);
	});
});

describe('reset', () => {
	test('empties the tables and the outbox, captures nothing, and starts over under a new client id', () => {
		const { a } = setup();
		a.db.exec("INSERT INTO notes (id, title) VALUES ('n1', 'kept')");
		a.sync();
		a.db.exec("INSERT INTO notes (id, title) VALUES ('n2', 'pending')");
		const before = a.client.clientId();
		expect([...a.client.reset()]).toEqual(['notes']);
		expect(a.rows()).toEqual([]);
		expect(a.client.pending()).toBe(0);
		expect(a.client.cursor()).toBe(0);
		expect(a.client.clientId()).not.toBe(before);
		a.pull();
		expect(a.rows().map(row => row.id)).toEqual(['n1']);
	});
});

/** A device that synced with `old` and is now pointed at `fresh`, a space that never saw its rows. */
function moved(oldNotes: string[], freshNotes: string[], options: SpaceOptions = {}) {
	const old = setup(schema, options);
	const fresh = setup(schema, options);
	for (const [index, id] of oldNotes.entries()) insert(old.a, id, `old ${index}`);
	old.a.sync();
	for (const [index, id] of freshNotes.entries()) insert(fresh.b, id, `fresh ${index}`);
	fresh.b.sync();
	const device = old.a;
	return { device, fresh, sync: () => syncPages(fresh.server, device.client) };
}

describe('space identity', () => {
	test('every space mints its own id, kept across migrations and sent on every protocol 2 response', () => {
		const { server, a } = setup();
		const id = server.space();
		server.migrate();
		expect(server.space()).toBe(id);
		expect(setup().server.space()).not.toBe(id);
		expect(a.pull().space).toBe(id);
		expect(a.client.space()).toBe(id);
	});

	test('a cursor from another space below this head gets a snapshot, and the device ends with exactly this space', () => {
		const { device, fresh, sync } = moved(['o1'], ['f1', 'f2', 'f3']);
		expect(device.client.cursor()).toBe(1);
		expect(fresh.server.head()).toBe(3);
		insert(device, 'mine', 'written offline');

		const response = sync();
		expect(response.snapshot).toBe(true);
		expect(device.rows().map(r => [r.id, r.title])).toEqual([
			['f1', 'fresh 0'],
			['f2', 'fresh 1'],
			['f3', 'fresh 2'],
			['mine', 'written offline'],
		]);
		expect(device.client.space()).toBe(fresh.server.space());
		expect(device.client.cursor()).toBe(4);
		expect(fresh.server.dump().notes!.map(r => r.id)).toEqual(['f1', 'f2', 'f3', 'mine']);
		expect(sync().snapshot).toBe(false);
	});

	test('a client older than spaces gets a snapshot for a cursor past the head, which only another space issues', () => {
		const { device, fresh } = moved(['o1', 'o2', 'o3', 'o4'], ['f1']);
		const request = (cursor: number) =>
			fresh.server.sync({ protocol: 2, client: device.client.clientId(), cursor, writes: [] });
		expect(request(4)).toMatchObject({ head: 1, snapshot: true, rows: [{ id: 'f1' }] });
		expect(request(1)).toMatchObject({ head: 1, snapshot: false, rows: [] });
		expect(fresh.server.sync({ protocol: 1, client: device.client.clientId(), cursor: 4, writes: [] })).toMatchObject({
			snapshot: true,
			rows: [{ id: 'f1' }],
		});
	});

	test('a paged snapshot interrupted by a space change restarts from the first page and ends with only the new rows', () => {
		const { device, fresh } = moved([], ['f1', 'f2', 'f3'], { pageSize: 2 });
		const old = setup(schema, { pageSize: 2 });
		for (const id of ['o1', 'o2', 'o3']) insert(old.a, id, id);
		old.a.sync();
		const first = old.server.sync({ protocol: 2, client: device.client.clientId(), cursor: 0, writes: [], space: '' });
		device.client.apply(first, 0);
		expect(device.client.snapshot()).toEqual({ after: { table: 'notes', id: 'o2' }, head: 3 });

		const page = fresh.server.sync({
			protocol: 2,
			client: device.client.clientId(),
			cursor: device.client.cursor(),
			writes: [],
			after: device.client.snapshot()!.after,
			space: device.client.space(),
		});
		expect(page.rows.map(r => r.id)).toEqual(['f1', 'f2']);
		device.client.apply(page, 0);
		syncPages(fresh.server, device.client, { writes: [], acked: 0 });
		expect(device.rows().map(r => r.id)).toEqual(['f1', 'f2', 'f3']);
		expect(device.client.cursor()).toBe(3);
	});

	test('a cursor past the head finishes a paged snapshot, with a space or without one', () => {
		for (const sendsSpace of [true, false]) {
			const { device, fresh } = moved(['o1', 'o2', 'o3', 'o4', 'o5'], ['f1', 'f2', 'f3'], { pageSize: 2 });
			expect(device.client.cursor()).toBeGreaterThan(fresh.server.head());
			const pages: string[][] = [];
			do {
				const progress = device.client.snapshot();
				const page = fresh.server.sync({
					protocol: 2,
					client: device.client.clientId(),
					cursor: device.client.cursor(),
					writes: [],
					...(progress ? { after: progress.after } : {}),
					...(sendsSpace ? { space: device.client.space() } : {}),
				});
				device.client.apply(page, 0);
				pages.push(page.rows.map(r => r.id));
			} while (device.client.snapshot() && pages.length < 5);
			expect(pages).toEqual([['f1', 'f2'], ['f3']]);
			expect(device.rows().map(r => r.id)).toEqual(['f1', 'f2', 'f3']);
			expect(device.client.cursor()).toBe(3);
		}
	});

	test('a response from a server older than spaces leaves the stored space alone', () => {
		const { a, server } = setup();
		a.pull();
		const id = a.client.space();
		insert(a, 'n1', 'one');
		const batch = a.client.collect();
		const { space: _, ...older } = server.sync({
			protocol: 2,
			client: a.client.clientId(),
			cursor: a.client.cursor(),
			writes: batch.writes,
			space: id,
		});
		a.client.apply(older, batch.acked);
		expect(a.client.space()).toBe(id);
		expect(a.rows().map(r => r.id)).toEqual(['n1']);
	});
});

describe('space hooks', () => {
	const notes = sqliteTable('notes', {
		id: text('id').primaryKey(),
		owner: text('owner').notNull(),
		title: text('title').notNull(),
		author: text('author'),
	});
	const grants = sqliteTable('grants', {
		id: text('id').primaryKey(),
		reader: text('reader').notNull(),
		note: text('note').notNull(),
	});
	const schema = defineSchema({ tables: { notes, grants } });

	type Context = { user: string };

	function setup(hooks: SpaceHooks<Context>) {
		const driver = bunSqlite(':memory:');
		const space = createSpace(driver, schema, { hooks });
		space.migrate();
		const sync = (user: string, writes: Write[], cursor = 0, client = `${user}-device`) =>
			space.sync({ protocol: 2, client, cursor, writes }, { user });
		return { driver, space, sync };
	}

	const put = (seq: number, id: string, values: Record<string, string | null>): Write => ({
		seq,
		table: 'notes',
		id,
		op: 'put',
		values,
	});
	const ids = (rows: readonly PulledRow[]) => rows.map(row => `${row.table}:${row.id}:${row.deleted}`);

	describe('admit', () => {
		const ownOnly: SpaceHooks<Context> = {
			admit(write, { user }) {
				if (write.op === 'put' && write.values.owner !== user) return 'not yours';
				if (write.op === 'put' && write.values.title === 'skip') return null;
				return write.op === 'put' ? { ...write, values: { ...write.values, author: user } } : write;
			},
		};

		test('stamps, refuses, and skips with the request context', () => {
			const { driver, sync } = setup(ownOnly);
			const response = sync('ann', [
				put(1, 'a', { owner: 'ann', title: 'mine', author: 'forged' }),
				put(2, 'b', { owner: 'bob', title: 'theirs' }),
				put(3, 'c', { owner: 'ann', title: 'skip' }),
			]);
			expect(response.acked).toBe(3);
			expect(response.head).toBe(1);
			expect(response.rejected).toEqual([{ seq: 2, table: 'notes', id: 'b', reason: 'not yours' }]);
			expect(driver.exec('SELECT id, author FROM notes')).toEqual([{ id: 'a', author: 'ann' }]);
		});

		test('a skipped write gets the server row back, and a throw or a moved write refuses only that write', () => {
			const { sync } = setup({
				admit(write) {
					if (write.id === 'boom') throw new Error('no such rule');
					if (write.id === 'moved') return { ...write, id: 'elsewhere' };
					if (write.op === 'put' && write.values.title === 'skip') return null;
					return write;
				},
			});
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'kept' })]);
			const response = sync('ann', [
				put(2, 'a', { owner: 'ann', title: 'skip' }),
				put(3, 'boom', { owner: 'ann', title: 'x' }),
				put(4, 'moved', { owner: 'ann', title: 'x' }),
				put(5, 'b', { owner: 'ann', title: 'lands' }),
			]);
			expect(response.rejected.map(r => r.id)).toEqual(['boom', 'moved']);
			expect(response.acked).toBe(5);
			const a = response.rows.find(row => row.id === 'a');
			expect(a && !a.deleted && a.values.title).toBe('kept');
		});

		test('a refused write is not replayed by a retry', () => {
			const { sync } = setup(ownOnly);
			sync('ann', [put(1, 'b', { owner: 'bob', title: 'theirs' })]);
			expect(sync('ann', [put(1, 'b', { owner: 'bob', title: 'theirs' })]).rejected).toEqual([]);
		});
	});

	describe('landed', () => {
		test('derived writes count, sync, and see the applied values', () => {
			const seen: string[] = [];
			const { space, sync } = setup({
				landed(writes, _context, server) {
					for (const write of writes) {
						seen.push(`${write.op}:${write.id}`);
						if (write.op === 'put') server.put('grants', `g-${write.id}`, { reader: 'bob', note: write.id });
						if (write.op === 'delete') server.delete('grants', `g-${write.id}`);
					}
				},
			});
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
			expect(space.head()).toBe(2);
			expect(ids(sync('bob', [], 0).rows)).toEqual(['notes:a:0', 'grants:g-a:0']);
			sync('ann', [{ seq: 2, table: 'notes', id: 'a', op: 'delete' }]);
			expect(seen).toEqual(['put:a', 'delete:a']);
			expect(ids(sync('bob', [], 2).rows)).toEqual(['notes:a:1', 'grants:g-a:1']);
		});

		test('runs only when a write counted', () => {
			let calls = 0;
			const { sync } = setup({ landed: () => void calls++ });
			sync('ann', [{ seq: 1, table: 'notes', id: 'gone', op: 'patch', values: { title: 'x' } }]);
			expect(calls).toBe(0);
		});
	});

	describe('view', () => {
		const shared: SpaceHooks<Context> = {
			view({ user }) {
				return {
					sees(table, values) {
						if (table === 'grants') return values.reader === user;
						if (values.owner === user) return true;
						return grantedTo(user, String(values.id));
					},
					expand(rows) {
						return rows.flatMap(row => {
							if (row.table !== 'grants') return [];
							const [reader, note] = row.id.split(':');
							if (reader !== user) return [];
							const found = noteRow(note!);
							return row.deleted || !found ? [{ table: 'notes', id: note!, deleted: 1 as const }] : [found];
						});
					},
				};
			},
			admit(write, { user }) {
				if (write.table === 'notes' && write.op === 'put' && write.values.owner !== user) return 'not shared with you';
				return write;
			},
		};
		let grantedTo: (user: string, note: string) => boolean = () => false;
		let noteRow: (id: string) => PulledRow | undefined = () => undefined;

		function shareSetup() {
			const env = setup(shared);
			grantedTo = (user, note) =>
				env.driver.exec('SELECT 1 FROM grants WHERE reader = ? AND note = ?', [user, note]).length > 0;
			noteRow = id => {
				const row = env.driver.exec('SELECT id, owner, title, author FROM notes WHERE id = ?', [id])[0];
				return row && { table: 'notes', id, deleted: 0, values: row as Record<string, string | null> };
			};
			return env;
		}

		test('a snapshot holds only the rows the reader sees', () => {
			const { space, sync } = shareSetup();
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' }), put(2, 'b', { owner: 'ann', title: 'two' })]);
			space.write([{ table: 'grants', id: 'bob:b', op: 'put', values: { reader: 'bob', note: 'b' } }], { user: 'ann' });
			expect(ids(sync('bob', []).rows)).toEqual(['notes:b:0', 'grants:bob:b:0']);
			expect(ids(sync('cat', []).rows)).toEqual([]);
		});

		test('a grant made later opens an old row, and its removal closes it', () => {
			const { space, sync } = shareSetup();
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
			const cursor = sync('bob', []).head;
			space.write([{ table: 'grants', id: 'bob:a', op: 'put', values: { reader: 'bob', note: 'a' } }], { user: 'ann' });
			const opened = sync('bob', [], cursor);
			expect(ids(opened.rows)).toEqual(['grants:bob:a:0', 'notes:a:0']);
			space.write([{ table: 'grants', id: 'bob:a', op: 'delete' }], { user: 'ann' });
			expect(ids(sync('bob', [], opened.head).rows)).toEqual(['grants:bob:a:1', 'notes:a:1']);
		});

		test('a row that changed in the delta that also took its grant away comes back as a tombstone', () => {
			const { space, sync } = shareSetup();
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
			space.write([{ table: 'grants', id: 'bob:a', op: 'put', values: { reader: 'bob', note: 'a' } }], { user: 'ann' });
			const cursor = sync('bob', []).head;
			sync('ann', [put(2, 'a', { owner: 'ann', title: 'renamed' })]);
			space.write([{ table: 'grants', id: 'bob:a', op: 'delete' }], { user: 'ann' });
			expect(ids(sync('bob', [], cursor).rows).toSorted()).toEqual(['grants:bob:a:1', 'notes:a:1']);
		});

		test("another reader's changes never reach a reader, not even as tombstones", () => {
			const { sync } = shareSetup();
			const cursor = sync('cat', []).head;
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'private' })]);
			expect(ids(sync('cat', [], cursor).rows)).toEqual([]);
		});

		test('a refused write the reader cannot see comes back as a tombstone', () => {
			const { sync } = shareSetup();
			sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
			const response = sync('bob', [put(1, 'a', { owner: 'ann', title: 'stolen' })]);
			expect(response.rejected.map(r => r.reason)).toEqual(['not shared with you']);
			expect(ids(response.rows)).toEqual(['notes:a:1']);
		});
	});

	describe('write', () => {
		const hooks: SpaceHooks<Context> = {
			admit: (write, { user }) => (write.op === 'put' && write.values.owner !== user ? 'not yours' : write),
		};

		test('applies through admit and reports the new head', () => {
			const { space } = setup(hooks);
			const result = space.write([{ table: 'notes', id: 'a', op: 'put', values: { owner: 'ann', title: 'one' } }], {
				user: 'ann',
			});
			expect(result).toEqual({ rejected: [], head: 1 });
		});

		test('atomic rolls back every write when one is refused', () => {
			const { driver, space } = setup(hooks);
			const result = space.write(
				[
					{ table: 'notes', id: 'a', op: 'put', values: { owner: 'ann', title: 'one' } },
					{ table: 'notes', id: 'b', op: 'put', values: { owner: 'bob', title: 'two' } },
				],
				{ user: 'ann' },
				{ atomic: true },
			);
			expect(result).toEqual({ rejected: [{ seq: 0, table: 'notes', id: 'b', reason: 'not yours' }], head: 0 });
			expect(driver.exec('SELECT id FROM notes')).toEqual([]);
		});
	});

	describe('change', () => {
		test('server rows written outside a sync count and reach readers', () => {
			const { space, sync } = setup({});
			const head = space.change(server => {
				server.put('notes', 'a', { owner: 'ann', title: 'derived' });
				return space.head();
			});
			expect(head).toBe(1);
			expect(ids(sync('bob', []).rows)).toEqual(['notes:a:0']);
			expect(() => space.change(server => server.put('notes', 'b', { owner: 'ann' }))).toThrow();
		});
	});
});
