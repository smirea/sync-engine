import { migrate } from './schema.ts';
import { rowKey, upsert } from './sql.ts';
import type {
	After,
	Column,
	PulledRow,
	Rejected,
	Row,
	Schema,
	SqlDriver,
	SqlValue,
	SyncRequest,
	SyncResponse,
	Table,
	Value,
	Values,
	Write,
} from './types.ts';

export type SpaceOptions = {
	/** Milliseconds a tombstone and its log row stay before compaction may drop them. Default 30 days. */
	retention?: number;
	/** Milliseconds between compactions, checked at the end of every sync. Default one hour. */
	compactEvery?: number;
	/** Most rows in one protocol 2 snapshot page. Default 1000. */
	pageSize?: number;
	now?: () => number;
};

export type Space = {
	migrate(): void;
	sync(request: SyncRequest): SyncResponse;
	/** Drops tombstones and log rows older than `retention`, moves the horizon up to them and returns it. */
	compact(): number;
	head(): number;
	dump(): Record<string, Row[]>;
};

const DAY = 86_400_000;

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
		if (column.name === 'id') {
			const reason = checkValue(column, write.id);
			if (reason) return { reason };
			continue;
		}
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

export function createSpace(driver: SqlDriver, schema: Schema, options: SpaceOptions = {}): Space {
	const tables = new Map(schema.tables.map(table => [table.name, table]));
	const retention = options.retention ?? 30 * DAY;
	const compactEvery = options.compactEvery ?? DAY / 24;
	const pageSize = options.pageSize ?? 1000;
	const now = options.now ?? Date.now;
	if (!Number.isInteger(pageSize) || pageSize < 1)
		throw new Error(`pageSize must be a positive integer, got ${pageSize}`);
	if (retention < 0 || compactEvery < 0) throw new Error('retention and compactEvery must not be negative');

	const meta = (key: string) => {
		const row = driver.exec('SELECT value FROM _meta WHERE key = ?', [key])[0];
		if (!row) throw new Error('space is not migrated');
		return Number(row.value);
	};
	const setMeta = (key: string, value: number) => driver.exec('UPDATE _meta SET value = ? WHERE key = ?', [value, key]);

	const live = (table: Table, row: Row): PulledRow => ({
		table: table.name,
		id: String(row.id),
		deleted: 0,
		values: wire(table, row),
	});

	const current = (table: Table, id: string, deleted: SqlValue | undefined): PulledRow[] => {
		if (deleted) return [{ table: table.name, id, deleted: 1 }];
		const row = driver.exec(`SELECT ${columnList(table)} FROM ${table.name} WHERE id = ?`, [id])[0];
		return row ? [live(table, row)] : [];
	};

	function snapshot(after: After | null, limit: number | null): { rows: PulledRow[]; next: After | null } {
		const rows: PulledRow[] = [];
		const found = after ? schema.tables.findIndex(table => table.name === after.table) : -1;
		const start = Math.max(0, found);
		for (let i = start; i < schema.tables.length; i++) {
			const table = schema.tables[i]!;
			const from = after && i === found ? [after.id] : [];
			const sql = `SELECT ${columnList(table)} FROM ${table.name}${from.length ? ' WHERE id > ?' : ''} ORDER BY id LIMIT ?`;
			for (const row of driver.exec(sql, [...from, limit === null ? -1 : limit + 1 - rows.length]))
				rows.push(live(table, row));
			if (limit !== null && rows.length > limit) {
				rows.length = limit;
				const last = rows[limit - 1]!;
				return { rows, next: { table: last.table, id: last.id } };
			}
		}
		return { rows, next: null };
	}

	const delta = (cursor: number): PulledRow[] =>
		driver.exec('SELECT "table", id, deleted FROM _changes WHERE seq > ? ORDER BY seq', [cursor]).flatMap(change => {
			const table = tables.get(String(change.table));
			return table ? current(table, String(change.id), change.deleted) : [];
		});

	function withRejected(rows: PulledRow[], rejected: Rejected[]): PulledRow[] {
		const seen = new Set(rows.map(row => rowKey(row.table, row.id)));
		for (const { table: name, id } of rejected) {
			const table = tables.get(name);
			if (!table || seen.has(rowKey(name, id))) continue;
			seen.add(rowKey(name, id));
			const change = driver.exec('SELECT deleted FROM _changes WHERE "table" = ? AND id = ?', [name, id])[0];
			rows.push(...(change ? current(table, id, change.deleted) : [{ table: name, id, deleted: 1 as const }]));
		}
		return rows;
	}

	function compactNow(): number {
		const at = now();
		const stale = driver.exec('SELECT max(seq) AS seq FROM _log WHERE at < ?', [at - retention])[0]?.seq;
		const horizon = Math.max(meta('horizon'), Number(stale ?? 0));
		driver.exec('DELETE FROM _changes WHERE deleted = 1 AND seq <= ?', [horizon]);
		driver.exec('DELETE FROM _log WHERE seq <= ?', [horizon]);
		setMeta('horizon', horizon);
		setMeta('compacted_at', at);
		return horizon;
	}

	function sync(request: SyncRequest): SyncResponse {
		return driver.transaction(() => {
			const rejected: Rejected[] = [];
			let seq = meta('head');
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
					now(),
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
						upsert(driver, table.name, write.id, checked.values);
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

			for (const write of request.writes.toSorted((x, y) => x.seq - y.seq)) {
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
			if (seq !== start) setMeta('head', seq);

			// A cursor below the horizon may have missed tombstones that are gone, so it gets a snapshot like cursor 0.
			const snapshotting = request.cursor === 0 || request.cursor < meta('horizon');
			const paged = request.protocol === 2;
			const page = snapshotting
				? snapshot(paged ? (request.after ?? null) : null, paged ? pageSize : null)
				: { rows: delta(request.cursor), next: null };
			const response: SyncResponse = {
				head: seq,
				acked: last,
				rejected,
				snapshot: snapshotting,
				rows: withRejected(page.rows, rejected),
			};
			if (paged) response.next = page.next;
			if (now() - meta('compacted_at') > compactEvery) compactNow();
			return response;
		});
	}

	return {
		migrate() {
			migrate(driver, schema, 'server');
			driver.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('head', 0), ('horizon', 0), ('compacted_at', 0)");
		},
		sync,
		compact: () => driver.transaction(compactNow),
		head: () => meta('head'),
		dump: () =>
			Object.fromEntries(
				schema.tables.map(table => [
					table.name,
					driver.exec(`SELECT ${columnList(table)} FROM ${table.name} ORDER BY id`),
				]),
			),
	};
}
