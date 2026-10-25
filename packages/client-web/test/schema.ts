import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { defineSchema } from '../../core/src/index.ts';

export const notes = sqliteTable('notes', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	done: integer('done').notNull().default(0),
});

export const schema = defineSchema({ tables: { notes } });
