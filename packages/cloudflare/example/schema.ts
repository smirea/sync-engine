import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { defineSchema } from '@sync-engine/core';

export const todos = sqliteTable('todos', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	done: integer('done', { mode: 'boolean' }).notNull().default(false),
});

export const schema = defineSchema({ tables: { todos } });
