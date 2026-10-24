import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '@sync-engine/bun-sqlite';
import type { ModelState, PulledVector, Rows, SparseRow, VectorWrite, Vectors } from '../../spec/vectors.ts';
import {
	createClient,
	createSpace,
	defineSchema,
	type PulledRow,
	type Space,
	type SqlDriver,
	type Write,
} from './src/index.ts';

const spec = join(import.meta.dir, '../../spec');
const vectors = JSON.parse(readFileSync(join(spec, 'vectors.json'), 'utf8')) as Vectors;

const TABLES = ['t0', 't1'];
const COLUMNS = ['c0', 'c1', 'c2'];
const table = (name: string) =>
	sqliteTable(name, { id: text('id').primaryKey(), c0: integer('c0'), c1: integer('c1'), c2: integer('c2') });
const schema = defineSchema({ tables: { t0: table('t0'), t1: table('t1') } });

type Dense = Record<string, number | null>;
type DenseRows = Record<string, Record<string, Dense>>;
type Changes = Record<string, Record<string, { seq: number; deleted: number }>>;
type Observed = { rows: DenseRows; head: number; changes: Changes; clients: Record<string, number> };

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
	return { rows: expandRows(state.rows), head: state.head, changes, clients: state.clients };
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
	};
}

const toWrite = (w: VectorWrite): Write =>
	w.op === 'delete'
		? { seq: w.seq, table: w.table, id: w.id, op: w.op }
		: { seq: w.seq, table: w.table, id: w.id, op: w.op, values: w.values };
const toPulled = (r: PulledVector): PulledRow =>
	r.deleted ? r : { table: r.table, id: r.id, deleted: 0, values: { id: r.id, ...dense(r.values) } };
const sorted = (rows: PulledRow[]) =>
	rows.toSorted((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));

function freshSpace() {
	const driver = bunSqlite(':memory:');
	const space = createSpace(driver, schema);
	space.migrate();
	return { driver, space };
}

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
			const { driver, space } = freshSpace();
			scenario.writes.forEach((w, i) => {
				space.sync({ protocol: 1, client: w.client, cursor: 0, writes: [toWrite(w)] });
				const step = `write ${i}: ${w.client} seq ${w.seq} ${w.op} ${w.table}/${w.id}`;
				expect({ step, ...observed(driver, space) }).toEqual({ step, ...expected(w.state) });
			});
			for (const pull of scenario.pulls) {
				const response = space.sync({ protocol: 1, client: 'puller', cursor: pull.cursor, writes: [] });
				const live = pull.cursor === 0 ? pull.rows.filter(r => r.deleted === 0) : pull.rows;
				expect({
					cursor: pull.cursor,
					head: response.head,
					snapshot: response.snapshot,
					rows: sorted(response.rows),
				}).toEqual({
					cursor: pull.cursor,
					head: pull.head,
					snapshot: pull.cursor === 0,
					rows: sorted(live.map(toPulled)),
				});
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
			const driver = bunSqlite(':memory:');
			const client = createClient(driver, schema);
			client.migrate();
			for (const [t, rows] of Object.entries(local)) {
				for (const [id, row] of Object.entries(rows)) {
					driver.exec(`INSERT INTO ${t} (id, c0, c1, c2) VALUES (?, ?, ?, ?)`, [
						id,
						...COLUMNS.map(c => row[c] ?? null),
					]);
				}
			}
			driver.exec('DELETE FROM _outbox');
			client.apply({ head: pull.head, acked: 0, rejected: [], snapshot: false, rows: pull.rows.map(toPulled) }, 0);
			expect({ rows: readRows(driver), cursor: client.cursor() }).toEqual({
				rows: expandRows(result.local),
				cursor: result.cursor,
			});
		});
	});
}
