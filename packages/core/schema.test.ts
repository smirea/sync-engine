import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { blob, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { defineSchema } from './src/index.ts';

const notes = sqliteTable('notes', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body').notNull().default("it's"),
	done: integer('done', { mode: 'boolean' }).notNull().default(false),
	tags: text('tags', { mode: 'json' }).notNull().default([]),
	weight: real('weight'),
	at: integer('at', { mode: 'timestamp' }),
});

describe('defineSchema', () => {
	test('derives columns, defaults and the DDL from a drizzle table', () => {
		const schema = defineSchema({ tables: { notes }, values: { notes: { tags: z.array(z.string()) } } });
		expect(schema.tables.map(t => ({ ...t, columns: t.columns.map(({ validate: _validate, ...c }) => c) }))).toEqual([
			{
				name: 'notes',
				columns: [
					{ name: 'id', type: 'TEXT', notNull: true, json: false },
					{ name: 'title', type: 'TEXT', notNull: true, json: false },
					{ name: 'body', type: 'TEXT', notNull: true, json: false, default: "it's" },
					{ name: 'done', type: 'INTEGER', notNull: true, json: false, default: 0 },
					{ name: 'tags', type: 'TEXT', notNull: true, json: true, default: '[]' },
					{ name: 'weight', type: 'REAL', notNull: false, json: false },
					{ name: 'at', type: 'INTEGER', notNull: false, json: false },
				],
			},
		]);
		expect(schema.tables[0]!.columns[4]!.validate?.safeParse(['a']).success).toBe(true);
		expect(schema.ddl.app).toEqual([
			"CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT 'it''s', done INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', weight REAL, at INTEGER)",
		]);
		expect(schema.ddl.client.slice(2, 5)).toEqual([
			"CREATE TRIGGER IF NOT EXISTS _ob_i_notes AFTER INSERT ON notes WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'insert', NULL); END",
			"CREATE TRIGGER IF NOT EXISTS _ob_d_notes AFTER DELETE ON notes WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', OLD.id, 'delete', NULL); END",
			"CREATE TRIGGER IF NOT EXISTS _ob_u_notes_title AFTER UPDATE OF title ON notes WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.title IS NOT NEW.title BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'title'); END",
		]);
		expect(schema.ddl.client).toHaveLength(2 + 2 + 6);
	});

	test('refuses what the protocol cannot carry', () => {
		const id = text('id').primaryKey();
		expect(() => defineSchema({ tables: { a: sqliteTable('a', { id, data: blob('data') }) } })).toThrow(
			'a.data: SQLiteBlobBuffer has no SQLite storage class here',
		);
		expect(() => defineSchema({ tables: { a: sqliteTable('a', { id: integer('id').primaryKey() }) } })).toThrow(
			'a: every synced table needs id TEXT PRIMARY KEY',
		);
		expect(() => defineSchema({ tables: { a: sqliteTable('a', { id, camelCase: text('camelCase') }) } })).toThrow(
			'a.camelCase: column name camelCase must match',
		);
		expect(() => defineSchema({ tables: { a: sqliteTable('Bad-Name', { id }) } })).toThrow(
			'table name Bad-Name must match',
		);
		expect(() =>
			defineSchema({ tables: { a: sqliteTable('a', { id, at: integer('at').default(sql`(unixepoch())`) }) } }),
		).toThrow('a.at: sql defaults are not supported');
		const a = sqliteTable('a', { id, x: text('x') });
		expect(() => defineSchema({ tables: { a }, values: { a: { y: z.string() } } as never })).toThrow(
			'a.y: values names a column the table lacks',
		);
		expect(() => defineSchema({ tables: { a }, values: { b: {} } as never })).toThrow('values names table b');
	});
});
