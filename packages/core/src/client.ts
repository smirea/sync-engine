import { migrate } from './schema.ts';
import type { Schema, SqlDriver, SqlValue, SyncResponse, Table, Value, Values, Write } from './types.ts';

export type Client = {
	migrate(): void;
	collect(): { writes: Write[]; acked: number };
	apply(response: SyncResponse, acked: number): Set<string>;
	cursor(): number;
	pending(): number;
	clientId(): string;
};

type Group = { table: string; id: string; seq: number; ops: string[]; cols: Set<string> };

const key = (table: SqlValue, id: SqlValue) => `${String(table)}\u0000${String(id)}`;

export function createClient(driver: SqlDriver, schema: Schema): Client {
	const tables = new Map(schema.tables.map(table => [table.name, table]));

	const meta = (name: string) => driver.exec('SELECT value FROM _meta WHERE key = ?', [name])[0]?.value;
	const setMeta = (name: string, value: SqlValue) =>
		driver.exec('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [name, value]);

	const readRow = (table: Table, id: string): Values | null => {
		const row = driver.exec(`SELECT ${table.columns.map(c => c.name).join(', ')} FROM ${table.name} WHERE id = ?`, [
			id,
		])[0];
		return row ? (Object.fromEntries(table.columns.map(c => [c.name, row[c.name] as Value])) as Values) : null;
	};

	function collect() {
		const groups = new Map<string, Group>();
		let acked = 0;
		for (const row of driver.exec('SELECT seq, "table", id, op, col FROM _outbox ORDER BY seq')) {
			const seq = Number(row.seq);
			acked = seq;
			const k = key(row.table, row.id);
			const group = groups.get(k) ?? { table: String(row.table), id: String(row.id), seq, ops: [], cols: new Set() };
			group.seq = seq;
			group.ops.push(String(row.op));
			if (row.col !== null) group.cols.add(String(row.col));
			groups.set(k, group);
		}
		const writes: Write[] = [];
		for (const { table, id, seq, ops, cols } of groups.values()) {
			if (ops.at(-1) === 'delete') {
				writes.push({ seq, table, id, op: 'delete' });
				continue;
			}
			const definition = tables.get(table);
			const row = definition && readRow(definition, id);
			if (!row) continue;
			if (ops.includes('insert')) writes.push({ seq, table, id, op: 'put', values: row });
			else writes.push({ seq, table, id, op: 'patch', values: Object.fromEntries([...cols].map(c => [c, row[c]!])) });
		}
		return { writes, acked };
	}

	function apply(response: SyncResponse, acked: number): Set<string> {
		return driver.transaction(() => {
			const touched = new Set<string>();
			setMeta('applying', 1);
			if (response.snapshot) {
				for (const table of schema.tables) {
					driver.exec(`DELETE FROM ${table.name}`);
					touched.add(table.name);
				}
			}
			const pending = new Set(
				driver.exec('SELECT "table", id FROM _outbox WHERE seq > ?', [acked]).map(row => key(row.table, row.id)),
			);
			for (const pulled of response.rows) {
				const table = tables.get(pulled.table);
				if (!table || pending.has(key(pulled.table, pulled.id))) continue;
				touched.add(table.name);
				if (pulled.deleted) {
					driver.exec(`DELETE FROM ${table.name} WHERE id = ?`, [pulled.id]);
					continue;
				}
				const columns = table.columns.filter(c => c.name !== 'id');
				driver.exec(
					`INSERT OR REPLACE INTO ${table.name} (id${columns.map(c => `, ${c.name}`).join('')}) VALUES (?${', ?'.repeat(columns.length)})`,
					[pulled.id, ...columns.map(c => pulled.values[c.name] ?? c.default ?? null)],
				);
			}
			driver.exec('DELETE FROM _outbox WHERE seq <= ?', [acked]);
			setMeta('cursor', response.head);
			setMeta('applying', 0);
			return touched;
		});
	}

	return {
		migrate() {
			migrate(driver, schema, 'client');
			driver.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('client', ?), ('cursor', 0)", [
				crypto.randomUUID(),
			]);
		},
		collect,
		apply,
		cursor: () => Number(meta('cursor')),
		pending: () => Number(driver.exec('SELECT count(*) AS n FROM _outbox')[0]!.n),
		clientId: () => String(meta('client')),
	};
}
