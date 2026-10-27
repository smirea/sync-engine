import { migrate } from './schema.ts';
import { rowKey, upsert } from './sql.ts';
import type { After, Schema, SqlDriver, SqlValue, SyncResponse, Table, Value, Values, Write } from './types.ts';

/** A paged snapshot in progress: the page to request next and the head of its first page, the cursor once it ends. */
export type SnapshotProgress = { after: After; head: number };

export type Client = {
	migrate(): void;
	collect(): { writes: Write[]; acked: number };
	apply(response: SyncResponse, acked: number): Set<string>;
	cursor(): number;
	snapshot(): SnapshotProgress | null;
	pending(): number;
	clientId(): string;
	/**
	 * Empties every app table and the outbox and starts over under a new client id at cursor 0, as a fresh database
	 * would: for an app that signs another user in on the same device. Captures nothing. Answers the tables it emptied.
	 */
	reset(): Set<string>;
};

type Group = { table: string; id: string; seq: number; ops: string[]; cols: Set<string> };

export function createClient(driver: SqlDriver, schema: Schema): Client {
	const tables = new Map(schema.tables.map(table => [table.name, table]));

	const meta = (name: string) => driver.exec('SELECT value FROM _meta WHERE key = ?', [name])[0]?.value;
	const setMeta = (name: string, value: SqlValue) =>
		driver.exec('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [name, value]);
	const snapshot = (): SnapshotProgress | null => {
		const after = meta('after');
		return after ? { after: JSON.parse(String(after)) as After, head: Number(meta('snapshot_head')) } : null;
	};

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
			const k = rowKey(String(row.table), String(row.id));
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
			if (acked > 0 && response.acked > acked) {
				// The server knows this client id past what we sent: a restored backup or a copied database. Under a
				// fresh id the next sync re-sends the outbox instead of having it skipped as a replay.
				setMeta('client', crypto.randomUUID());
				return touched;
			}
			setMeta('applying', 1);
			const progress = snapshot();
			const pendingRows = driver
				.exec('SELECT "table", id FROM _outbox WHERE seq > ?', [acked])
				.map(row => ({ table: String(row.table), id: String(row.id) }));
			const pending = new Set(pendingRows.map(row => rowKey(row.table, row.id)));
			if (response.snapshot && !progress) {
				for (const table of schema.tables) {
					const keep = pendingRows.filter(row => row.table === table.name).map(row => row.id);
					driver.exec(
						`DELETE FROM ${table.name}${keep.length ? ` WHERE id NOT IN (${keep.map(() => '?').join(', ')})` : ''}`,
						keep,
					);
					touched.add(table.name);
				}
			}
			for (const pulled of response.rows) {
				const table = tables.get(pulled.table);
				if (!table || pending.has(rowKey(pulled.table, pulled.id))) continue;
				const columns = table.columns.filter(c => c.name !== 'id');
				const changed = pulled.deleted
					? driver.exec(`DELETE FROM ${table.name} WHERE id = ? RETURNING 1`, [pulled.id]).length > 0
					: upsert(
							driver,
							table.name,
							pulled.id,
							Object.fromEntries(
								columns.map(c => {
									const value = pulled.values[c.name];
									return [c.name, value === undefined ? (c.default ?? null) : value];
								}),
							),
						);
				if (changed) touched.add(table.name);
			}
			driver.exec('DELETE FROM _outbox WHERE seq <= ?', [acked]);
			const head = progress?.head ?? response.head;
			if (response.next) {
				setMeta('after', JSON.stringify(response.next));
				setMeta('snapshot_head', head);
			} else {
				// The first page's head: rows that changed while later pages were fetched come with the next delta.
				setMeta('cursor', head);
				driver.exec("DELETE FROM _meta WHERE key IN ('after', 'snapshot_head')");
			}
			setMeta('applying', 0);
			return touched;
		});
	}

	const start = () =>
		driver.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('client', ?), ('cursor', 0)", [crypto.randomUUID()]);

	return {
		migrate() {
			migrate(driver, schema, 'client');
			start();
		},
		reset: () =>
			driver.transaction(() => {
				setMeta('applying', 1);
				for (const table of schema.tables) driver.exec(`DELETE FROM ${table.name}`);
				driver.exec('DELETE FROM _outbox');
				driver.exec('DELETE FROM _meta');
				start();
				return new Set(schema.tables.map(table => table.name));
			}),
		collect,
		apply,
		cursor: () => Number(meta('cursor')),
		snapshot,
		pending: () => Number(driver.exec('SELECT count(*) AS n FROM _outbox')[0]!.n),
		clientId: () => String(meta('client')),
	};
}
