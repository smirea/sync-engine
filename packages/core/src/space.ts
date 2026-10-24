import { migrate } from './schema.ts';
import type {
	Column,
	PulledRow,
	Rejected,
	Row,
	Schema,
	SqlDriver,
	SyncRequest,
	SyncResponse,
	Table,
	Value,
	Values,
	Write,
} from './types.ts';

export type Space = {
	migrate(): void;
	sync(request: SyncRequest): SyncResponse;
	head(): number;
	dump(): Record<string, Row[]>;
};

type Checked = { values: Values } | { reason: string };

function checkValue(column: Column, value: Value): string | null {
	if (value === null) return column.notNull ? `${column.name}: NOT NULL` : null;
	let parsed: unknown = value;
	if (typeof value === 'string') {
		if (column.type !== 'TEXT') return `${column.name}: expected ${column.type}`;
		if (column.json) {
			try {
				parsed = JSON.parse(value);
			} catch {
				return `${column.name}: invalid JSON`;
			}
		}
	} else if (
		column.type === 'TEXT' ||
		!Number.isFinite(value) ||
		(column.type === 'INTEGER' && !Number.isInteger(value))
	) {
		return `${column.name}: expected ${column.type}`;
	}
	if (column.validate) {
		const result = column.validate.safeParse(parsed);
		if (!result.success) return `${column.name}: ${result.error.issues[0]?.message ?? 'invalid'}`;
	}
	return null;
}

function checkValues(table: Table, write: Extract<Write, { values: Values }>): Checked {
	const values: Values = {};
	for (const column of table.columns) {
		if (column.name === 'id') continue;
		const given = write.values[column.name];
		if (given === undefined) {
			if (write.op === 'patch') continue;
			if (column.default !== undefined) values[column.name] = column.default;
			else if (column.notNull) return { reason: `${column.name}: required` };
			else values[column.name] = null;
			continue;
		}
		const reason = checkValue(column, given);
		if (reason) return { reason };
		values[column.name] = given;
	}
	return { values };
}

const columnList = (table: Table) => table.columns.map(c => c.name).join(', ');
const wire = (table: Table, row: Row): Values =>
	Object.fromEntries(table.columns.map(c => [c.name, row[c.name] as Value]));

export function createSpace(driver: SqlDriver, schema: Schema): Space {
	const tables = new Map(schema.tables.map(table => [table.name, table]));

	const head = () => {
		const row = driver.exec("SELECT value FROM _meta WHERE key = 'head'")[0];
		if (!row) throw new Error('space is not migrated');
		return Number(row.value);
	};

	function pull(cursor: number): PulledRow[] {
		if (cursor === 0) {
			return schema.tables.flatMap(table =>
				driver
					.exec(`SELECT ${columnList(table)} FROM ${table.name} ORDER BY id`)
					.map(row => ({ table: table.name, id: String(row.id), deleted: 0, values: wire(table, row) })),
			);
		}
		return driver
			.exec('SELECT "table", id, deleted FROM _changes WHERE seq > ? ORDER BY seq', [cursor])
			.flatMap((change): PulledRow[] => {
				const table = tables.get(String(change.table));
				if (!table) return [];
				const id = String(change.id);
				if (change.deleted) return [{ table: table.name, id, deleted: 1 }];
				const row = driver.exec(`SELECT ${columnList(table)} FROM ${table.name} WHERE id = ?`, [id])[0];
				return row ? [{ table: table.name, id, deleted: 0, values: wire(table, row) }] : [];
			});
	}

	function sync(request: SyncRequest): SyncResponse {
		return driver.transaction(() => {
			const rejected: Rejected[] = [];
			let seq = head();
			const start = seq;
			const acked = Number(driver.exec('SELECT seq FROM _clients WHERE client = ?', [request.client])[0]?.seq ?? 0);
			let last = acked;

			const touch = (write: Write, deleted: 0 | 1, log: Values | null) => {
				seq += 1;
				driver.exec(
					'INSERT INTO _changes ("table", id, seq, deleted) VALUES (?, ?, ?, ?) ON CONFLICT("table", id) DO UPDATE SET seq = excluded.seq, deleted = excluded.deleted',
					[write.table, write.id, seq, deleted],
				);
				driver.exec('INSERT INTO _log (seq, at, client, "table", id, op, "values") VALUES (?, ?, ?, ?, ?, ?, ?)', [
					seq,
					Date.now(),
					request.client,
					write.table,
					write.id,
					write.op,
					log && JSON.stringify(log),
				]);
			};

			const apply = (table: Table, write: Write): string | null => {
				switch (write.op) {
					case 'delete': {
						driver.exec(`DELETE FROM ${table.name} WHERE id = ?`, [write.id]);
						touch(write, 1, null);
						return null;
					}
					case 'put': {
						const checked = checkValues(table, write);
						if ('reason' in checked) return checked.reason;
						const names = Object.keys(checked.values);
						driver.exec(
							`INSERT OR REPLACE INTO ${table.name} (id${names.map(n => `, ${n}`).join('')}) VALUES (?${', ?'.repeat(names.length)})`,
							[write.id, ...names.map(n => checked.values[n]!)],
						);
						touch(write, 0, checked.values);
						return null;
					}
					case 'patch': {
						const checked = checkValues(table, write);
						if ('reason' in checked) return checked.reason;
						if (!driver.exec(`SELECT 1 FROM ${table.name} WHERE id = ?`, [write.id]).length) return null;
						const names = Object.keys(checked.values);
						if (names.length) {
							driver.exec(`UPDATE ${table.name} SET ${names.map(n => `${n} = ?`).join(', ')} WHERE id = ?`, [
								...names.map(n => checked.values[n]!),
								write.id,
							]);
						}
						touch(write, 0, checked.values);
						return null;
					}
				}
			};

			for (const write of request.writes) {
				if (write.seq <= last) continue;
				last = write.seq;
				const table = tables.get(write.table);
				const reason = table ? apply(table, write) : `unknown table ${write.table}`;
				if (reason) rejected.push({ seq: write.seq, table: write.table, id: write.id, reason });
			}

			if (last !== acked) {
				driver.exec(
					'INSERT INTO _clients (client, seq) VALUES (?, ?) ON CONFLICT(client) DO UPDATE SET seq = excluded.seq',
					[request.client, last],
				);
			}
			if (seq !== start) driver.exec("UPDATE _meta SET value = ? WHERE key = 'head'", [seq]);

			return { head: seq, acked: last, rejected, snapshot: request.cursor === 0, rows: pull(request.cursor) };
		});
	}

	return {
		migrate() {
			migrate(driver, schema, 'server');
			driver.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('head', 0)");
		},
		sync,
		head,
		dump: () =>
			Object.fromEntries(
				schema.tables.map(table => [
					table.name,
					driver.exec(`SELECT ${columnList(table)} FROM ${table.name} ORDER BY id`),
				]),
			),
	};
}
