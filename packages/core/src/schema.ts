import { getTableColumns, getTableName, is, SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { ZodType } from 'zod';
import type { Column, Schema, SqlDriver, StorageClass, Table, Value } from './types.ts';

const STORAGE: Record<string, StorageClass> = {
	SQLiteText: 'TEXT',
	SQLiteTextJson: 'TEXT',
	SQLiteInteger: 'INTEGER',
	SQLiteTimestamp: 'INTEGER',
	SQLiteBoolean: 'INTEGER',
	SQLiteReal: 'REAL',
};
const NAME = /^[a-z_][a-z0-9_]*$/;

type DrizzleColumn = { name: string; columnType: string; notNull: boolean; primary: boolean; default: unknown };
type Tables = Record<string, SQLiteTable>;
type Validators<T extends Tables> = { [K in keyof T]?: { [C in keyof T[K]['_']['columns']]?: ZodType } };

function plainDefault(where: string, raw: unknown, json: boolean): Value | undefined {
	if (raw === undefined) return undefined;
	if (is(raw, SQL)) throw new Error(`${where}: sql defaults are not supported, use a plain value`);
	if (json) return JSON.stringify(raw);
	if (typeof raw === 'boolean') return raw ? 1 : 0;
	if (typeof raw === 'string' || typeof raw === 'number' || raw === null) return raw;
	throw new Error(`${where}: unsupported default ${String(raw)}`);
}

function toColumn(table: string, key: string, column: DrizzleColumn, validate: ZodType | undefined): Column {
	const where = `${table}.${key}`;
	if (!NAME.test(column.name)) throw new Error(`${where}: column name ${column.name} must match ${NAME}`);
	const type = STORAGE[column.columnType];
	if (!type)
		throw new Error(`${where}: ${column.columnType} has no SQLite storage class here (use text, integer or real)`);
	const json = column.columnType === 'SQLiteTextJson';
	const out: Column = { name: column.name, type, notNull: column.notNull, json };
	const fallback = plainDefault(where, column.default, json);
	if (fallback !== undefined) out.default = fallback;
	if (validate) out.validate = validate;
	return out;
}

function toTable(table: SQLiteTable, validators: Record<string, ZodType | undefined>): Table {
	const name = getTableName(table);
	if (!NAME.test(name)) throw new Error(`table name ${name} must match ${NAME}`);
	const entries = Object.entries(getTableColumns(table) as Record<string, DrizzleColumn>);
	for (const key of Object.keys(validators)) {
		if (!entries.some(([k]) => k === key)) throw new Error(`${name}.${key}: values names a column the table lacks`);
	}
	const id = entries.find(([, column]) => column.name === 'id');
	if (!id || !id[1].primary || id[1].columnType !== 'SQLiteText') {
		throw new Error(`${name}: every synced table needs id TEXT PRIMARY KEY`);
	}
	const rest = entries.filter(entry => entry !== id);
	return { name, columns: [id, ...rest].map(([key, column]) => toColumn(name, key, column, validators[key])) };
}

export function defineSchema<T extends Tables>({ tables, values = {} }: { tables: T; values?: Validators<T> }): Schema {
	for (const key of Object.keys(values)) {
		if (!(key in tables)) throw new Error(`values names table ${key}, which tables lacks`);
	}
	const list = Object.entries(tables).map(([key, table]) =>
		toTable(table, (values[key] ?? {}) as Record<string, ZodType | undefined>),
	);
	const names = new Set<string>();
	for (const table of list) {
		if (names.has(table.name)) throw new Error(`table ${table.name} is defined twice`);
		names.add(table.name);
	}
	return {
		tables: list,
		ddl: { app: list.map(createTable), server: SERVER_DDL, client: [...CLIENT_DDL, ...list.flatMap(triggers)] },
	};
}

const literal = (value: Value) =>
	value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;

const columnDdl = (column: Column) =>
	column.name === 'id'
		? 'id TEXT PRIMARY KEY'
		: `${column.name} ${column.type}${column.notNull ? ' NOT NULL' : ''}${column.default === undefined ? '' : ` DEFAULT ${literal(column.default)}`}`;

const createTable = (table: Table) =>
	`CREATE TABLE IF NOT EXISTS ${table.name} (${table.columns.map(columnDdl).join(', ')})`;

const SERVER_DDL = [
	'CREATE TABLE IF NOT EXISTS _changes ("table" TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("table", id))',
	'CREATE INDEX IF NOT EXISTS _changes_seq ON _changes (seq)',
	'CREATE TABLE IF NOT EXISTS _clients (client TEXT PRIMARY KEY, seq INTEGER NOT NULL)',
	'CREATE TABLE IF NOT EXISTS _log (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, client TEXT NOT NULL, "table" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, "values" TEXT)',
	'CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value)',
];

const CLIENT_DDL = [
	'CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, "table" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, col TEXT)',
	'CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value)',
];

const NOT_APPLYING = "coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0";

function triggers({ name: t, columns }: Table): string[] {
	const queue = (id: string, op: string, col: string) =>
		`BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('${t}', ${id}, '${op}', ${col}); END`;
	return [
		`CREATE TRIGGER IF NOT EXISTS _ob_i_${t} AFTER INSERT ON ${t} WHEN ${NOT_APPLYING} ${queue('NEW.id', 'insert', 'NULL')}`,
		`CREATE TRIGGER IF NOT EXISTS _ob_d_${t} AFTER DELETE ON ${t} WHEN ${NOT_APPLYING} ${queue('OLD.id', 'delete', 'NULL')}`,
		...columns
			.filter(c => c.name !== 'id')
			.map(
				({ name: c }) =>
					`CREATE TRIGGER IF NOT EXISTS _ob_u_${t}_${c} AFTER UPDATE OF ${c} ON ${t} WHEN ${NOT_APPLYING} AND OLD.${c} IS NOT NEW.${c} ${queue('NEW.id', 'update', `'${c}'`)}`,
			),
	];
}

export function migrate(driver: SqlDriver, schema: Schema, side: 'server' | 'client'): void {
	driver.transaction(() => {
		for (const sql of schema.ddl.app) driver.exec(sql);
		for (const table of schema.tables) {
			const present = new Set(driver.exec(`PRAGMA table_info(${table.name})`).map(row => row.name));
			for (const column of table.columns) {
				if (present.has(column.name)) continue;
				if (column.notNull && column.default === undefined) {
					throw new Error(
						`${table.name}.${column.name}: a NOT NULL column without a default cannot be added to an existing table`,
					);
				}
				driver.exec(`ALTER TABLE ${table.name} ADD COLUMN ${columnDdl(column)}`);
			}
		}
		for (const sql of schema.ddl[side]) driver.exec(sql);
	});
}
