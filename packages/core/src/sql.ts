import type { SqlDriver, Values } from './types.ts';

export const rowKey = (table: string, id: string) => `${table}\u0000${id}`;

/** An upsert, never INSERT OR REPLACE: that is a delete plus an insert and cascades through foreign keys. */
export function upsert(driver: SqlDriver, table: string, id: string, values: Values): void {
	const names = Object.keys(values);
	const update = names.length ? `DO UPDATE SET ${names.map(n => `${n} = excluded.${n}`).join(', ')}` : 'DO NOTHING';
	driver.exec(
		`INSERT INTO ${table} (id${names.map(n => `, ${n}`).join('')}) VALUES (?${', ?'.repeat(names.length)}) ON CONFLICT (id) ${update}`,
		[id, ...names.map(n => values[n]!)],
	);
}
