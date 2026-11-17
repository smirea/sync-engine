import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { defineSchema } from '../core/src/index.ts';
import { generate } from './src/index.ts';

const schema = defineSchema({
	tables: {
		notes: sqliteTable('notes', {
			id: text('id').primaryKey(),
			title: text('title').notNull().default(''),
			body: text('body'),
			stars: integer('stars').notNull().default(0),
		}),
		tags: sqliteTable('tags', {
			id: text('id').primaryKey(),
			name: text('name').notNull(),
			weight: real('weight'),
		}),
	},
});

const statements = (ddl: string) => ddl.split(';\n').slice(0, -1);

/** What the Swift client's `migrate()` does with the generated statements: an ADD COLUMN the table has is skipped. */
function migrate(db: Database, ddl: string) {
	for (const sql of statements(ddl)) {
		try {
			db.run(sql);
		} catch (error) {
			if (!sql.startsWith('ALTER TABLE') || !String(error).includes('duplicate column name')) throw error;
		}
	}
}

const columns = (db: Database, table: string) => db.query('SELECT name FROM pragma_table_info(?)').values(table).flat();

describe('generate', () => {
	test('the generated DDL creates a fresh database and grows a table created by an older schema', () => {
		const { ddl } = generate({ schema });
		const fresh = new Database(':memory:');
		migrate(fresh, ddl);
		expect(columns(fresh, 'notes')).toEqual(['id', 'title', 'body', 'stars']);
		expect(columns(fresh, 'tags')).toEqual(['id', 'name', 'weight']);

		const older = new Database(':memory:');
		older.run("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '')");
		older.run("INSERT INTO notes (id, title) VALUES ('n1', 'kept')");
		migrate(older, ddl);
		expect(columns(older, 'notes')).toEqual(['id', 'title', 'body', 'stars']);
		expect(older.query('SELECT * FROM notes').all()).toEqual([{ id: 'n1', title: 'kept', body: null, stars: 0 }]);
	});

	test('the Swift schema names every column but id and carries the same statements as the DDL', () => {
		const { swift, ddl } = generate({ schema });
		const tables = [...swift.matchAll(/SyncTable\(name: "(\w+)", columns: \[(.*)\]\)/g)].map(([, name, list]) => [
			name,
			JSON.parse(`[${list}]`),
		]);
		expect(tables).toEqual([
			['notes', ['title', 'body', 'stars']],
			['tags', ['name', 'weight']],
		]);
		const literals = swift
			.slice(swift.indexOf('statements: ['))
			.split('\n')
			.slice(1, -3)
			.map(line => JSON.parse(line.trim().replace(/,$/, '')));
		expect(literals).toEqual(statements(ddl));
	});
});
