import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '../packages/bun-sqlite/src/index.ts';
import { serve } from '../packages/bun-server/src/index.ts';
import { bearerToken, defineSchema } from '../packages/core/src/index.ts';

// The server half of Tests/SyncEngineTests: the schema mirrors Fixture.schema, argv[2] is the space options as JSON.
const schema = defineSchema({
	tables: {
		notes: sqliteTable('notes', {
			id: text('id').primaryKey(),
			title: text('title').notNull(),
			body: text('body'),
			stars: integer('stars').notNull().default(0),
		}),
		tags: sqliteTable('tags', {
			id: text('id').primaryKey(),
			name: text('name').notNull(),
			weight: real('weight'),
			color: text('color'),
		}),
	},
});
const server = serve({
	driver: bunSqlite(':memory:'),
	schema,
	authorize: request => bearerToken(request) === 'secret',
	hostname: '127.0.0.1',
	port: 0,
	space: JSON.parse(process.argv[2] ?? '{}'),
});
console.log(server.port);
// Exits when the test process closes stdin or dies, so a crashed test run leaves no server behind.
for await (const _ of Bun.stdin.stream());
process.exit(0);
