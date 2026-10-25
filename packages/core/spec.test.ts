import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import type {
	LocalOp,
	ModelState,
	PulledVector,
	PullVector,
	Rows,
	SparseRow,
	VectorWrite,
	Vectors,
	WriteVector,
} from '../../spec/vectors.ts';
import {
	createClient,
	createSpace,
	defineSchema,
	type PulledRow,
	type Space,
	type SqlDriver,
	type SyncResponse,
	type Write,
} from './src/index.ts';

const spec = join(import.meta.dir, '../../spec');
const vectors = JSON.parse(readFileSync(join(spec, 'vectors.json'), 'utf8')) as Vectors;

const TABLES = ['t0', 't1'];
const COLUMNS = ['c0', 'c1', 'c2'];
const RETENTION = 30 * 86_400_000;
const table = (name: string) =>
	sqliteTable(name, { id: text('id').primaryKey(), c0: integer('c0'), c1: integer('c1'), c2: integer('c2') });
const schema = defineSchema({ tables: { t0: table('t0'), t1: table('t1') } });

type Dense = Record<string, number | null>;
type DenseRows = Record<string, Record<string, Dense>>;
type Changes = Record<string, Record<string, { seq: number; deleted: number }>>;
type Observed = { rows: DenseRows; head: number; changes: Changes; clients: Record<string, number>; horizon: number };

const dense = (row: SparseRow): Dense => Object.fromEntries(COLUMNS.map(c => [c, row[c] ?? null]));
const expandRows = (rows: Rows): DenseRows =>
	Object.fromEntries(
		TABLES.map(t => [t, Object.fromEntries(Object.entries(rows[t] ?? {}).map(([id, row]) => [id, dense(row)]))]),
	);
const readRows = (driver: SqlDriver): DenseRows =>
	Object.fromEntries(
		TABLES.map(t => [
			t,
			Object.fromEntries(driver.exec(`SELECT * FROM ${t}`).map(({ id, ...row }) => [String(id), row as Dense])),
		]),
	);

function expected(state: ModelState): Observed {
	const changes: Changes = Object.fromEntries(
		TABLES.map(t => [
			t,
			Object.fromEntries(
				Object.entries(state.changes[t] ?? {}).map(([id, seq]) => [id, { seq, deleted: state.rows[t]?.[id] ? 0 : 1 }]),
			),
		]),
	);
	return { rows: expandRows(state.rows), head: state.head, changes, clients: state.clients, horizon: state.horizon };
}

function observed(driver: SqlDriver, space: Space): Observed {
	const changes: Changes = Object.fromEntries(TABLES.map(t => [t, {}]));
	for (const row of driver.exec('SELECT "table", id, seq, deleted FROM _changes')) {
		changes[String(row.table)]![String(row.id)] = { seq: Number(row.seq), deleted: Number(row.deleted) };
	}
	return {
		rows: readRows(driver),
		head: space.head(),
		changes,
		clients: Object.fromEntries(
			driver.exec('SELECT client, seq FROM _clients').map(r => [String(r.client), Number(r.seq)]),
		),
		horizon: Number(driver.exec("SELECT value FROM _meta WHERE key = 'horizon'")[0]!.value),
	};
}

const toWrite = (w: WriteVector): Write =>
	w.op === 'delete'
		? { seq: w.seq, table: w.table, id: w.id, op: w.op }
		: { seq: w.seq, table: w.table, id: w.id, op: w.op, values: w.values };
const toPulled = (r: PulledVector): PulledRow =>
	r.deleted ? r : { table: r.table, id: r.id, deleted: 0, values: { id: r.id, ...dense(r.values) } };
const toResponse = (pull: PullVector): SyncResponse => ({
	head: pull.head,
	acked: 0,
	rejected: [],
	snapshot: pull.snapshot,
	rows: pull.rows.map(toPulled),
});
const sorted = (rows: PulledRow[]) =>
	rows.toSorted((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
/** A collected write as the model sees it: the sparse columns, no id and no nulls. */
const fromCollected = (w: Write): WriteVector =>
	w.op === 'delete'
		? { seq: w.seq, table: w.table, id: w.id, op: w.op }
		: {
				seq: w.seq,
				table: w.table,
				id: w.id,
				op: w.op,
				values: Object.fromEntries(
					Object.entries(w.values).filter(([c, v]) => c !== 'id' && v !== null) as [string, number][],
				),
			};

/** A space whose clock is the number of writes applied so far, so `_log.at` of write i is i. */
function freshSpace(pageSize?: number) {
	const driver = bunSqlite(':memory:');
	const time = { now: 0 };
	const space = createSpace(driver, schema, { now: () => time.now, pageSize });
	space.migrate();
	let applied = 0;
	return {
		driver,
		space,
		time,
		applyUpTo(writes: VectorWrite[], count: number) {
			for (; applied < count; applied++) {
				const w = writes[applied]!;
				time.now = applied + 1;
				space.sync({ protocol: 1, client: w.client, cursor: 0, writes: [toWrite(w)] });
			}
		},
	};
}

function freshClient(local: Rows) {
	const driver = bunSqlite(':memory:');
	const client = createClient(driver, schema);
	client.migrate();
	driver.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 1)");
	for (const [t, rows] of Object.entries(local)) {
		for (const [id, row] of Object.entries(rows)) {
			driver.exec(`INSERT INTO ${t} (id, c0, c1, c2) VALUES (?, ?, ?, ?)`, [id, ...COLUMNS.map(c => row[c] ?? null)]);
		}
	}
	driver.exec("UPDATE _meta SET value = 0 WHERE key = 'applying'");
	expect(client.pending()).toBe(0);
	return { driver, client };
}

const edit = (driver: SqlDriver, op: LocalOp) => {
	switch (op.op) {
		case 'insert':
			driver.exec(`INSERT INTO ${op.table} (id, c0, c1, c2) VALUES (?, ?, ?, ?)`, [
				op.id,
				...COLUMNS.map(c => op.values[c] ?? null),
			]);
			break;
		case 'update':
			driver.exec(`UPDATE ${op.table} SET ${op.col} = ? WHERE id = ?`, [op.value, op.id]);
			break;
		case 'delete':
			driver.exec(`DELETE FROM ${op.table} WHERE id = ?`, [op.id]);
			break;
	}
};

const pullOf = (response: SyncResponse) => ({
	head: response.head,
	snapshot: response.snapshot,
	rows: sorted(response.rows),
});
const expectedPull = (pull: PullVector) => ({
	head: pull.head,
	snapshot: pull.snapshot,
	rows: sorted(pull.rows.map(toPulled)),
});

test('spec/vectors.json is generated from the current spec/sync.bend', () => {
	const actual = createHash('sha256')
		.update(readFileSync(join(spec, 'sync.bend')))
		.digest('hex');
	if (vectors.bend_sha256 !== actual)
		throw new Error('spec/vectors.json is stale against spec/sync.bend: run `bun run spec-vectors`');
});

for (const scenario of vectors.scenarios) {
	describe(scenario.name, () => {
		test('every write lands in the model state, then every pull matches', () => {
			const { driver, space, applyUpTo } = freshSpace();
			scenario.writes.forEach((w, i) => {
				applyUpTo(scenario.writes, i + 1);
				const step = `write ${i}: ${w.client} seq ${w.seq} ${w.op} ${w.table}/${w.id}`;
				expect({ step, ...observed(driver, space) }).toEqual({ step, ...expected(w.state) });
			});
			for (const pull of scenario.pulls) {
				const response = space.sync({ protocol: 1, client: 'puller', cursor: pull.cursor, writes: [] });
				expect({ cursor: pull.cursor, ...pullOf(response) }).toEqual({ cursor: pull.cursor, ...expectedPull(pull) });
			}
		});

		test('the same writes batched per client run end in the same state', () => {
			const { driver, space } = freshSpace();
			const batches: { client: string; writes: Write[] }[] = [];
			for (const w of scenario.writes) {
				const last = batches.at(-1);
				if (last?.client === w.client) last.writes.push(toWrite(w));
				else batches.push({ client: w.client, writes: [toWrite(w)] });
			}
			expect(batches.length).toBeLessThan(scenario.writes.length);
			for (const { client, writes } of batches) space.sync({ protocol: 1, client, cursor: 0, writes });
			expect(observed(driver, space)).toEqual(expected(scenario.writes.at(-1)!.state));
		});

		test('applyPull on a client converges to the model', () => {
			const { local, pull, result } = scenario.applyPull;
			const { driver, client } = freshClient(local);
			client.apply(toResponse(pull), 0);
			expect({ rows: readRows(driver), cursor: client.cursor() }).toEqual({
				rows: expandRows(result.local),
				cursor: result.cursor,
			});
		});

		test('compaction drops the tombstones and log below the horizon and a cursor below it snapshots', () => {
			const { at, horizon, state, pulls } = scenario.compaction;
			const { driver, space, time, applyUpTo } = freshSpace();
			applyUpTo(scenario.writes, scenario.writes.length);
			time.now = RETENTION + at + 0.5;
			expect(space.compact()).toBe(horizon);
			expect(observed(driver, space)).toEqual(expected(state));
			expect(driver.exec('SELECT min(seq) AS low, count(*) AS n FROM _log')).toEqual([
				{ low: horizon + 1, n: state.head - horizon },
			]);
			for (const pull of pulls) {
				const response = space.sync({ protocol: 2, client: 'puller', cursor: pull.cursor, writes: [] });
				expect({ cursor: pull.cursor, next: response.next, ...pullOf(response) }).toEqual({
					cursor: pull.cursor,
					next: null,
					...expectedPull(pull),
				});
			}
		});

		test('an outbox coalesces like the model and its batch lands in any arrival order', () => {
			const { client: name, local, ops, writes, state } = scenario.batch;
			const server = freshSpace();
			server.applyUpTo(scenario.writes, scenario.writes.length);
			const { driver, client } = freshClient(local);
			for (const op of ops) edit(driver, op);
			const collected = client.collect().writes;
			expect(collected.map(fromCollected)).toEqual(writes);
			server.space.sync({ protocol: 2, client: name, cursor: 0, writes: collected });
			expect(observed(server.driver, server.space)).toEqual(expected(state));
		});

		test('pages taken while writes land, then one delta, converge to the final state', () => {
			const { size, pages, cursor, final } = scenario.paging;
			const server = freshSpace(size);
			const { driver, client } = freshClient({});
			for (const page of pages) {
				server.applyUpTo(scenario.writes, page.at);
				const progress = client.snapshot();
				expect(progress?.after ?? null).toEqual(page.after);
				const response = server.space.sync({
					protocol: 2,
					client: 'pager',
					cursor: client.cursor(),
					writes: [],
					...(progress ? { after: progress.after } : {}),
				});
				expect({ at: page.at, head: response.head, next: response.next, rows: response.rows }).toEqual({
					at: page.at,
					head: page.head,
					next: page.next,
					rows: page.rows.map(toPulled),
				});
				client.apply(response, 0);
			}
			expect({ snapshot: client.snapshot(), cursor: client.cursor() }).toEqual({ snapshot: null, cursor });
			server.applyUpTo(scenario.writes, scenario.writes.length);
			const delta = server.space.sync({ protocol: 2, client: 'pager', cursor: client.cursor(), writes: [] });
			client.apply(delta, 0);
			expect({ snapshot: delta.snapshot, rows: readRows(driver), cursor: client.cursor() }).toEqual({
				snapshot: false,
				rows: expandRows(final.local),
				cursor: final.cursor,
			});
		});
	});
}
