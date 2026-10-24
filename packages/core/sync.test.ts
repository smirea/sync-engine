import { describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { bunSqlite } from '@sync-engine/bun-sqlite';
import { createClient, createSpace, defineSchema, type Schema, type SqlDriver, type Write } from './src/index.ts';

const notes = sqliteTable('notes', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body').notNull().default(''),
	done: integer('done', { mode: 'boolean' }).notNull().default(false),
	tags: text('tags', { mode: 'json' }).notNull().default([]),
});
const schema = defineSchema({ tables: { notes }, values: { notes: { tags: z.array(z.string()) } } });

function setup(s: Schema = schema) {
	const serverDb = bunSqlite(':memory:');
	const server = createSpace(serverDb, s);
	server.migrate();
	const peer = () => {
		const db = bunSqlite(':memory:');
		const client = createClient(db, s);
		client.migrate();
		return {
			db,
			client,
			sync() {
				const { writes, acked } = client.collect();
				const response = server.sync({ protocol: 1, client: client.clientId(), cursor: client.cursor(), writes });
				client.apply(response, acked);
				return response;
			},
			pull() {
				const response = server.sync({ protocol: 1, client: client.clientId(), cursor: client.cursor(), writes: [] });
				client.apply(response, 0);
				return response;
			},
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
