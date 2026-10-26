import { describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import {
	createClient,
	createSpace,
	defineSchema,
	type Client,
	type Schema,
	type Space,
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
	do {
		const progress = client.snapshot();
		response = server.sync({
			protocol: 2,
			client: client.clientId(),
			cursor: client.cursor(),
			writes: batch.writes,
			...(progress ? { after: progress.after } : {}),
		});
		client.apply(response, batch.acked);
		batch = { writes: [], acked: 0 };
	} while (client.snapshot());
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
		const { serverDb, server, a } = setup();
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
		expect(serverDb.exec('SELECT count(*) AS n FROM _log')).toEqual([{ n: 1 }]);
	});

	test('a rejected write is dropped and the server row comes back', () => {
		const { a } = setup();
		insert(a, 'n1', 'tagged');
		a.sync();
		update(a, 'n1', 'tags', '[1]');
		const response = a.sync();
		expect(response.rejected).toEqual([
			{ seq: 2, table: 'notes', id: 'n1', reason: 'tags: Invalid input: expected string, received number' },
		]);
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
		expect(b.db.exec("SELECT value FROM _meta WHERE key = 'applying'")).toEqual([{ value: 0 }]);
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
		expect(v1.a.db.exec("SELECT name FROM sqlite_master WHERE name = '_ob_u_notes_priority'")).toHaveLength(1);
		update(v1.a, 'n1', 'priority', 5);
		const { writes, acked } = client.collect();
		expect(writes).toEqual([{ seq: 2, table: 'notes', id: 'n1', op: 'patch', values: { priority: 5 } }]);
		client.apply(server.sync({ protocol: 1, client: client.clientId(), cursor: client.cursor(), writes }), acked);
		expect(server.dump()).toEqual({ notes: [row('n1', 'old', { priority: 5 })] });
		const required = defineSchema({
			tables: { notes: sqliteTable('notes', { id: text('id').primaryKey(), owner: text('owner').notNull() }) },
		});
		expect(() => createSpace(v1.serverDb, required).migrate()).toThrow(
			'notes.owner: a NOT NULL column without a default cannot be added to an existing table',
		);
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
			rejected: [{ seq: 2, table: 'notes', id: 'n1', reason: 'title: expected TEXT' }],
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
			return { rows: response.rows.map(r => r.id), touched: [...peer.client.apply(response, batch.acked)] };
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

	test('compaction drops old tombstones and log rows, and a cursor behind the horizon snapshots and converges', () => {
		let clock = 1000;
		const { serverDb, server, a, b } = setup(schema, { now: () => clock, retention: 100, compactEvery: 10 });
		insert(a, 'n1', 'one');
		insert(a, 'n2', 'two');
		a.sync();
		b.sync();
		a.db.exec("DELETE FROM notes WHERE id = 'n1'");
		a.sync();
		expect(serverDb.exec('SELECT id, seq, deleted FROM _changes ORDER BY seq')).toEqual([
			{ id: 'n2', seq: 2, deleted: 0 },
			{ id: 'n1', seq: 3, deleted: 1 },
		]);
		clock = 1200;
		insert(a, 'n3', 'three');
		a.sync();
		expect(serverDb.exec('SELECT id, seq, deleted FROM _changes ORDER BY seq')).toEqual([
			{ id: 'n2', seq: 2, deleted: 0 },
			{ id: 'n3', seq: 4, deleted: 0 },
		]);
		expect(serverDb.exec('SELECT seq FROM _log')).toEqual([{ seq: 4 }]);
		expect(serverDb.exec("SELECT key, value FROM _meta WHERE key IN ('horizon', 'compacted_at') ORDER BY key")).toEqual(
			[
				{ key: 'compacted_at', value: 1200 },
				{ key: 'horizon', value: 3 },
			],
		);
		expect(server.compact()).toBe(3);

		expect(b.client.cursor()).toBe(2);
		const response = b.sync();
		expect(response).toEqual({
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
