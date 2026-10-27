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

/**
 * The app's rules, run by the space inside the sync transaction with the context the app passed for the request (the
 * signed-in user, say). Every hook is synchronous, since the transaction is.
 */
export type SpaceHooks<C> = {
	/**
	 * Runs for each write that passed the column checks, before it applies. Answers the write to apply, which may carry
	 * other values (a stamp the server owns), a string to refuse it with that reason, or null to skip it: acked and not
	 * counted, like a patch of a missing row. A patch of a missing row never reaches it.
	 */
	admit?(write: Write, context: C): Write | string | null;
	/**
	 * Runs once after a request's writes applied, with the writes that counted, as applied. `server` writes rows of its
	 * own in the same transaction (derived rows), which count and sync like any other but skip the hooks.
	 */
	landed?(writes: readonly Write[], context: C, server: ServerWriter): void;
	/** What the request's reader may pull. Without it every reader pulls every row. */
	view?(context: C): View;
};

/**
 * One reader's slice of the space. `sees` decides each live row of a pull. Tombstones always pass: the reader deletes a
 * row it never had at no cost, and the server no longer knows whose the row was. `expand` runs on a delta before the
 * filter and answers rows to add, such as the rows a new grant opened or tombstones for the rows a lost grant closed.
 */
export type View = {
	sees(table: string, values: Values): boolean;
	expand?(rows: readonly PulledRow[]): PulledRow[];
};

export type ServerWriter = {
	put(table: string, id: string, values: Values): void;
	patch(table: string, id: string, values: Values): void;
	delete(table: string, id: string): void;
};

/** A write the server makes for itself through `Space.write`, which has no client sequence. */
export type ServerWrite =
	| { table: string; id: string; op: 'put' | 'patch'; values: Values }
	| { table: string; id: string; op: 'delete' };

export type SpaceOptions<C = void> = {
	hooks?: SpaceHooks<C>;
	/** Milliseconds a tombstone and its log row stay before compaction may drop them. Default 30 days. */
	retention?: number;
	/** Milliseconds between compactions, checked at the end of every sync. Default one hour. */
	compactEvery?: number;
	/** Most rows in one protocol 2 snapshot page. Default 1000. */
	pageSize?: number;
	now?: () => number;
};

export type Space<C = void> = {
	migrate(): void;
	sync(request: SyncRequest, context: C): SyncResponse;
	/**
	 * Applies the server's own writes through the hooks, as the client `server`, in one transaction. With `atomic`, one
	 * refusal rolls the whole call back and nothing applies. Answers the refusals and the head after the call.
	 */
	write(
		writes: readonly ServerWrite[],
		context: C,
		options?: { atomic?: boolean },
	): { rejected: Rejected[]; head: number };
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

/** The client id the space's own writes are logged under. */
export const SERVER_CLIENT = 'server';

export function createSpace<C = void>(driver: SqlDriver, schema: Schema, options: SpaceOptions<C> = {}): Space<C> {
	const tables = new Map(schema.tables.map(table => [table.name, table]));
	const retention = options.retention ?? 30 * DAY;
	const compactEvery = options.compactEvery ?? DAY / 24;
	const pageSize = options.pageSize ?? 1000;
	const now = options.now ?? Date.now;
	const hooks = options.hooks ?? {};
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

	/** The reader's rows: a live row it does not see is dropped, or becomes a tombstone when `hide` names it. */
	function filtered(view: View, rows: readonly PulledRow[], hide: ReadonlySet<string>): PulledRow[] {
		const seen = new Set<string>();
		const out: PulledRow[] = [];
		for (const row of rows) {
			const key = rowKey(row.table, row.id);
			if (seen.has(key)) continue;
			seen.add(key);
			if (row.deleted || view.sees(row.table, row.values)) out.push(row);
			else if (hide.has(key)) out.push({ table: row.table, id: row.id, deleted: 1 });
		}
		return out;
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

	/**
	 * Applies writes in the given order as `client` and answers the refusals. The head advances in `_meta` as each write
	 * counts, so the derived writes of `landed` follow on from it.
	 */
	function applyAll(client: string, writes: readonly Write[], context: C): Rejected[] {
		const rejected: Rejected[] = [];
		const counted: Write[] = [];

		const touch = (by: string, write: Pick<Write, 'table' | 'id' | 'op'>, deleted: 0 | 1, log: Values | null) => {
			const seq = meta('head') + 1;
			setMeta('head', seq);
			driver.exec(
				'INSERT INTO _changes ("table", id, seq, deleted) VALUES (?, ?, ?, ?) ON CONFLICT("table", id) DO UPDATE SET seq = excluded.seq, deleted = excluded.deleted',
				[write.table, write.id, seq, deleted],
			);
			driver.exec('INSERT INTO _log (seq, at, client, "table", id, op, "values") VALUES (?, ?, ?, ?, ?, ?, ?)', [
				seq,
				now(),
				by,
				write.table,
				write.id,
				write.op,
				log && JSON.stringify(log),
			]);
		};

		/** Runs a checked write. Answers whether it counted. */
		const run = (by: string, table: Table, write: Write): boolean => {
			switch (write.op) {
				case 'delete':
					driver.exec(`DELETE FROM ${table.name} WHERE id = ?`, [write.id]);
					touch(by, write, 1, null);
					return true;
				case 'put':
					upsert(driver, table.name, write.id, write.values);
					touch(by, write, 0, write.values);
					return true;
				case 'patch': {
					const names = Object.keys(write.values);
					if (names.length) {
						driver.exec(`UPDATE ${table.name} SET ${names.map(n => `${n} = ?`).join(', ')} WHERE id = ?`, [
							...names.map(n => write.values[n]!),
							write.id,
						]);
					}
					touch(by, write, 0, write.values);
					return true;
				}
			}
		};

		const check = (table: Table, write: Write): Write | string | null => {
			if (write.op === 'delete') return write;
			const checked = checkValues(table, write);
			if ('reason' in checked) return checked.reason;
			if (write.op === 'patch' && !driver.exec(`SELECT 1 FROM ${table.name} WHERE id = ?`, [write.id]).length)
				return null;
			return { ...write, values: checked.values };
		};

		for (const write of writes) {
			const table = tables.get(write.table);
			let outcome: Write | string | null = table ? check(table, write) : `unknown table ${write.table}`;
			if (outcome !== null && typeof outcome !== 'string' && hooks.admit) outcome = hooks.admit(outcome, context);
			if (typeof outcome === 'string') {
				rejected.push({ seq: write.seq, table: write.table, id: write.id, reason: outcome });
				continue;
			}
			if (outcome && run(client, table!, outcome)) counted.push(outcome);
		}

		if (counted.length && hooks.landed) {
			const derived = (op: Write['op'], name: string, id: string, values?: Values) => {
				const table = tables.get(name);
				if (!table) throw new Error(`unknown table ${name}`);
				const write = { seq: 0, table: name, id, op, values: values ?? {} } as Write;
				const outcome = check(table, write);
				if (typeof outcome === 'string') throw new Error(`${name} ${id}: ${outcome}`);
				if (outcome) run(SERVER_CLIENT, table, outcome);
			};
			hooks.landed(counted, context, {
				put: (table, id, values) => derived('put', table, id, values),
				patch: (table, id, values) => derived('patch', table, id, values),
				delete: (table, id) => derived('delete', table, id),
			});
		}
		return rejected;
	}

	function sync(request: SyncRequest, context: C): SyncResponse {
		return driver.transaction(() => {
			const acked = Number(driver.exec('SELECT seq FROM _clients WHERE client = ?', [request.client])[0]?.seq ?? 0);
			let last = acked;
			const fresh: Write[] = [];
			for (const write of request.writes.toSorted((x, y) => x.seq - y.seq)) {
				if (write.seq <= last) continue;
				last = write.seq;
				fresh.push(write);
			}
			const rejected = applyAll(request.client, fresh, context);

			if (last !== acked) {
				driver.exec(
					'INSERT INTO _clients (client, seq) VALUES (?, ?) ON CONFLICT(client) DO UPDATE SET seq = excluded.seq',
					[request.client, last],
				);
			}
			const head = meta('head');

			// A cursor below the horizon may have missed tombstones that are gone, so it gets a snapshot like cursor 0.
			const snapshotting = request.cursor === 0 || request.cursor < meta('horizon');
			const paged = request.protocol === 2;
			const page = snapshotting
				? snapshot(paged ? (request.after ?? null) : null, paged ? pageSize : null)
				: { rows: delta(request.cursor), next: null };
			const view = hooks.view?.(context);
			let rows = withRejected(
				view?.expand && !snapshotting ? [...page.rows, ...view.expand(page.rows)] : page.rows,
				rejected,
			);
			if (view) rows = filtered(view, rows, new Set(rejected.map(r => rowKey(r.table, r.id))));
			const response: SyncResponse = { head, acked: last, rejected, snapshot: snapshotting, rows };
			if (paged) response.next = page.next;
			if (now() - meta('compacted_at') > compactEvery) compactNow();
			return response;
		});
	}

	function write(writes: readonly ServerWrite[], context: C, { atomic = false } = {}) {
		const run = () => {
			const rejected = applyAll(
				SERVER_CLIENT,
				writes.map(write => ({ ...write, seq: 0 }) as Write),
				context,
			);
			if (atomic && rejected.length) throw new Refused(rejected);
			return { rejected, head: meta('head') };
		};
		try {
			return driver.transaction(run);
		} catch (error) {
			if (error instanceof Refused) return { rejected: error.rejected, head: meta('head') };
			throw error;
		}
	}

	return {
		migrate() {
			migrate(driver, schema, 'server');
			driver.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('head', 0), ('horizon', 0), ('compacted_at', 0)");
		},
		sync,
		write,
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

class Refused extends Error {
	constructor(readonly rejected: Rejected[]) {
		super('refused');
	}
}
