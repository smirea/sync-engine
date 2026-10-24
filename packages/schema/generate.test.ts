import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSchema } from '../core/src/index.ts';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { generate } from './src/index.ts';

const fixture = defineSchema({
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

const fixtureStatements = [
	'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, stars INTEGER NOT NULL DEFAULT 0)',
	'ALTER TABLE notes ADD COLUMN title TEXT NOT NULL',
	'ALTER TABLE notes ADD COLUMN body TEXT',
	'ALTER TABLE notes ADD COLUMN stars INTEGER NOT NULL DEFAULT 0',
	'CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, weight REAL, color TEXT)',
	'ALTER TABLE tags ADD COLUMN name TEXT NOT NULL',
	'ALTER TABLE tags ADD COLUMN weight REAL',
	'ALTER TABLE tags ADD COLUMN color TEXT',
	'CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, "table" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, col TEXT)',
	'CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value)',
	"CREATE TRIGGER IF NOT EXISTS _ob_i_notes AFTER INSERT ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'insert', NULL); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_d_notes AFTER DELETE ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', OLD.id, 'delete', NULL); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_u_notes_title AFTER UPDATE OF title ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.title IS NOT NEW.title\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'title'); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_u_notes_body AFTER UPDATE OF body ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.body IS NOT NEW.body\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'body'); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_u_notes_stars AFTER UPDATE OF stars ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.stars IS NOT NEW.stars\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'stars'); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_i_tags AFTER INSERT ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'insert', NULL); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_d_tags AFTER DELETE ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', OLD.id, 'delete', NULL); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_u_tags_name AFTER UPDATE OF name ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.name IS NOT NEW.name\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'update', 'name'); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_u_tags_weight AFTER UPDATE OF weight ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.weight IS NOT NEW.weight\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'update', 'weight'); END",
	"CREATE TRIGGER IF NOT EXISTS _ob_u_tags_color AFTER UPDATE OF color ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.color IS NOT NEW.color\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'update', 'color'); END",
];

const aBetterMe = defineSchema({
	tables: {
		workoutTemplates: sqliteTable('workout_templates', {
			id: text('id').primaryKey(),
			name: text('name').notNull(),
			notes: text('notes').notNull().default(''),
			blocks: text('blocks', { mode: 'json' }).notNull().default([]),
			createdAt: text('created_at').notNull(),
			updatedAt: text('updated_at').notNull(),
			programId: text('program_id'),
			gymId: text('gym_id'),
			archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
		}),
		workoutSessions: sqliteTable('workout_sessions', {
			id: text('id').primaryKey(),
			name: text('name').notNull(),
			templateId: text('template_id'),
			startedAt: text('started_at').notNull(),
			endedAt: text('ended_at'),
			notes: text('notes').notNull().default(''),
			blocks: text('blocks', { mode: 'json' }).notNull().default([]),
			programId: text('program_id'),
			programDayId: text('program_day_id'),
			cycle: integer('cycle'),
			gymId: text('gym_id'),
			pausedSeconds: integer('paused_seconds').notNull().default(0),
		}),
		customExercises: sqliteTable('custom_exercises', {
			id: text('id').primaryKey(),
			exercise: text('exercise', { mode: 'json' }).notNull(),
			isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
		}),
		exerciseSettings: sqliteTable('exercise_settings', {
			id: text('id').primaryKey(),
			pinnedNote: text('pinned_note').notNull().default(''),
			restSeconds: integer('rest_seconds'),
			doNotRecommend: integer('do_not_recommend', { mode: 'boolean' }).notNull().default(false),
			overrides: text('overrides', { mode: 'json' }).notNull().default({}),
		}),
		settings: sqliteTable('settings', {
			id: text('id').primaryKey(),
			weightUnit: text('weight_unit', { enum: ['kg', 'lb'] })
				.notNull()
				.default('kg'),
			restCompoundUpper: integer('rest_compound_upper').notNull().default(120),
			restCompoundLower: integer('rest_compound_lower').notNull().default(180),
			restUpperIsolation: integer('rest_upper_isolation').notNull().default(90),
			restLowerIsolation: integer('rest_lower_isolation').notNull().default(90),
			restCore: integer('rest_core').notNull().default(60),
			workout: text('workout', { mode: 'json' }).notNull().default({}),
			profile: text('profile', { mode: 'json' }).notNull().default({}),
			dashboard: text('dashboard', { mode: 'json' }).notNull().default({}),
			shortcuts: text('shortcuts', { mode: 'json' }).notNull().default({}),
		}),
		programs: sqliteTable('programs', {
			id: text('id').primaryKey(),
			name: text('name').notNull(),
			color: text('color').notNull(),
			icon: text('icon').notNull(),
			cycles: integer('cycles').notNull(),
			currentCycle: integer('current_cycle').notNull().default(1),
			active: integer('active', { mode: 'boolean' }).notNull().default(false),
			archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
			config: text('config', { mode: 'json' }).notNull().default({}),
			days: text('days', { mode: 'json' }).notNull().default([]),
			createdAt: text('created_at').notNull(),
			updatedAt: text('updated_at').notNull(),
		}),
		gymProfiles: sqliteTable('gym_profiles', {
			id: text('id').primaryKey(),
			name: text('name').notNull(),
			icon: text('icon').notNull(),
			isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
			equipment: text('equipment', { mode: 'json' }).notNull().default({}),
			createdAt: text('created_at').notNull(),
			updatedAt: text('updated_at').notNull(),
		}),
		bodyWeights: sqliteTable('body_weights', {
			id: text('id').primaryKey(),
			measuredAt: text('measured_at').notNull(),
			weightKg: real('weight_kg').notNull(),
			source: text('source', { enum: ['manual', 'healthkit'] })
				.notNull()
				.default('manual'),
		}),
	},
	values: {
		settings: { weightUnit: z.enum(['kg', 'lb']) },
		bodyWeights: { source: z.enum(['manual', 'healthkit']) },
	},
});

describe('generate', () => {
	test('emits the statements and Swift file of the hand-written Swift fixture', () => {
		const out = generate({ schema: fixture });
		expect(out.ddl).toBe(fixtureStatements.map(sql => `${sql};\n`).join(''));
		expect(out.swift).toBe(String.raw`// Generated by sync-engine. Do not edit.
import SyncEngine

let syncSchema = SyncSchema(
    tables: [
        SyncTable(name: "notes", columns: ["title", "body", "stars"]),
        SyncTable(name: "tags", columns: ["name", "weight", "color"]),
    ],
    statements: [
        "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, stars INTEGER NOT NULL DEFAULT 0)",
        "ALTER TABLE notes ADD COLUMN title TEXT NOT NULL",
        "ALTER TABLE notes ADD COLUMN body TEXT",
        "ALTER TABLE notes ADD COLUMN stars INTEGER NOT NULL DEFAULT 0",
        "CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, weight REAL, color TEXT)",
        "ALTER TABLE tags ADD COLUMN name TEXT NOT NULL",
        "ALTER TABLE tags ADD COLUMN weight REAL",
        "ALTER TABLE tags ADD COLUMN color TEXT",
        "CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, \"table\" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, col TEXT)",
        "CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value)",
        "CREATE TRIGGER IF NOT EXISTS _ob_i_notes AFTER INSERT ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'insert', NULL); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_d_notes AFTER DELETE ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', OLD.id, 'delete', NULL); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_u_notes_title AFTER UPDATE OF title ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.title IS NOT NEW.title\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'title'); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_u_notes_body AFTER UPDATE OF body ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.body IS NOT NEW.body\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'body'); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_u_notes_stars AFTER UPDATE OF stars ON notes\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.stars IS NOT NEW.stars\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('notes', NEW.id, 'update', 'stars'); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_i_tags AFTER INSERT ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'insert', NULL); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_d_tags AFTER DELETE ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', OLD.id, 'delete', NULL); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_u_tags_name AFTER UPDATE OF name ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.name IS NOT NEW.name\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'update', 'name'); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_u_tags_weight AFTER UPDATE OF weight ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.weight IS NOT NEW.weight\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'update', 'weight'); END",
        "CREATE TRIGGER IF NOT EXISTS _ob_u_tags_color AFTER UPDATE OF color ON tags\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.color IS NOT NEW.color\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('tags', NEW.id, 'update', 'color'); END",
    ]
)
`);
	});

	test("generates a-better-me's eight tables as valid SQLite", () => {
		const out = generate({ schema: aBetterMe });
		const statements = out.ddl.split(';\n').slice(0, -1);
		const tables = [...out.swift.matchAll(/SyncTable\(name: "(\w+)", columns: \[(.*)\]\)/g)];
		expect(tables).toHaveLength(8);
		expect(tables[0]![1]).toBe('workout_templates');
		expect(tables[0]![2]).toBe(
			'"name", "notes", "blocks", "created_at", "updated_at", "program_id", "gym_id", "archived"',
		);
		expect(statements).toContain(
			"CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, weight_unit TEXT NOT NULL DEFAULT 'kg', rest_compound_upper INTEGER NOT NULL DEFAULT 120, rest_compound_lower INTEGER NOT NULL DEFAULT 180, rest_upper_isolation INTEGER NOT NULL DEFAULT 90, rest_lower_isolation INTEGER NOT NULL DEFAULT 90, rest_core INTEGER NOT NULL DEFAULT 60, workout TEXT NOT NULL DEFAULT '{}', profile TEXT NOT NULL DEFAULT '{}', dashboard TEXT NOT NULL DEFAULT '{}', shortcuts TEXT NOT NULL DEFAULT '{}')",
		);
		expect(statements).toContain(
			"CREATE TRIGGER IF NOT EXISTS _ob_u_settings_weight_unit AFTER UPDATE OF weight_unit ON settings\n  WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.weight_unit IS NOT NEW.weight_unit\n  BEGIN INSERT INTO _outbox (\"table\", id, op, col) VALUES ('settings', NEW.id, 'update', 'weight_unit'); END",
		);
		expect(statements).toHaveLength(8 + 55 + 2 + 8 * 2 + 55);
		expect(out.swift.split('\n').slice(0, 2)).toEqual([
			'// Generated by sync-engine. Do not edit.',
			'import SyncEngine',
		]);

		const db = new Database(':memory:');
		for (const sql of statements) {
			if (sql.startsWith('ALTER TABLE')) expect(() => db.run(sql)).toThrow('duplicate column name');
			else db.run(sql);
		}
		expect(db.query('SELECT name FROM pragma_table_info(?)').values('settings').flat()).toEqual([
			'id',
			'weight_unit',
			'rest_compound_upper',
			'rest_compound_lower',
			'rest_upper_isolation',
			'rest_lower_isolation',
			'rest_core',
			'workout',
			'profile',
			'dashboard',
			'shortcuts',
		]);
	});

	test('writes the files it returns', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync-engine-schema-'));
		const swift = join(dir, 'SyncSchema.swift');
		const ddl = join(dir, 'client.sql');
		const out = generate({ schema: fixture, swift, ddl });
		expect(readFileSync(swift, 'utf8')).toBe(out.swift);
		expect(readFileSync(ddl, 'utf8')).toBe(out.ddl);
		expect(out.ddl.startsWith(`${fixtureStatements[0]};\n`)).toBe(true);
	});
});
