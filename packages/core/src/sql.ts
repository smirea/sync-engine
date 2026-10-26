import type { SqlDriver, Values } from './types.ts';

export const rowKey = (table: string, id: string) => `${table}\u0000${id}`;

/**
 * An upsert, never INSERT OR REPLACE: that is a delete plus an insert and cascades through foreign keys. A row whose
 * values already match is not rewritten, so the update hook and table observers stay quiet; returns whether it wrote.
 */
export function upsert(driver: SqlDriver, table: string, id: string, values: Values): boolean {
	const names = Object.keys(values);
	const excluded = names.map(n => `excluded.${n}`);
	const update = names.length
		? `DO UPDATE SET ${names.map((n, i) => `${n} = ${excluded[i]}`).join(', ')} WHERE (${names.join(', ')}) IS NOT (${excluded.join(', ')})`
		: 'DO NOTHING';
	return (
		driver.exec(
			`INSERT INTO ${table} (id${names.map(n => `, ${n}`).join('')}) VALUES (?${', ?'.repeat(names.length)}) ON CONFLICT (id) ${update} RETURNING 1`,
			[id, ...names.map(n => values[n]!)],
		).length > 0
	);
}
