/**
 * Measures what a snapshot pull costs on a space with many rows and many tombstones:
 * `bun scripts/bench-pull.ts [rows] [tombstones]` (defaults 5000 and 20000, split over two tables).
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '../packages/bun-sqlite/src/index.ts';
import { createSpace, defineSchema, type SyncResponse, type Values, type Write } from '../packages/core/src/index.ts';

const rows = Number(Bun.argv[2] ?? 5000);
const tombstones = Number(Bun.argv[3] ?? 20000);
const BATCH = 5000;

const schema = defineSchema({
	tables: {
		items: sqliteTable('items', { id: text('id').primaryKey(), name: text('name').notNull(), qty: integer('qty') }),
		events: sqliteTable('events', { id: text('id').primaryKey(), kind: text('kind').notNull(), at: integer('at') }),
	},
});
const tables = ['items', 'events'] as const;
const values = (table: string, i: number): Values =>
	table === 'items' ? { name: `item ${i}`, qty: i % 7 } : { kind: `kind ${i % 5}`, at: i };

const driver = bunSqlite(':memory:');
const space = createSpace(driver, schema);
space.migrate();

let seq = 0;
const writes: Write[] = [];
for (let i = 0; i < rows; i++) {
	const table = tables[i % 2]!;
	writes.push({ seq: ++seq, table, id: `r${i}`, op: 'put', values: values(table, i) });
}
for (let i = 0; i < tombstones; i++) {
	const table = tables[i % 2]!;
	writes.push({ seq: ++seq, table, id: `t${i}`, op: 'put', values: values(table, i) });
	writes.push({ seq: ++seq, table, id: `t${i}`, op: 'delete' });
}
for (let i = 0; i < writes.length; i += BATCH) {
	space.sync({ protocol: 1, client: 'seed', cursor: 0, writes: writes.slice(i, i + BATCH) });
}

const count = (table: string) => Number(driver.exec(`SELECT count(*) AS n FROM ${table}`)[0]!.n);
const timed = (label: string, run: () => SyncResponse) => {
	const samples: number[] = [];
	let response!: SyncResponse;
	for (let i = 0; i < 5; i++) {
		const start = performance.now();
		response = run();
		samples.push(performance.now() - start);
	}
	const median = samples.toSorted((a, b) => a - b)[2]!;
	const bytes = JSON.stringify(response).length;
	console.log(
		`${label}: ${response.rows.length} rows, ${(bytes / 1024).toFixed(0)} KB, ${median.toFixed(1)} ms (median of 5)`,
	);
};

console.log(`seeded ${rows} rows and ${tombstones} tombstones, head ${space.head()}`);
console.log(`_changes ${count('_changes')} rows, _log ${count('_log')} rows`);
timed('cursor 0', () => space.sync({ protocol: 1, client: 'bench', cursor: 0, writes: [] }));
timed(`cursor ${rows}`, () => space.sync({ protocol: 1, client: 'bench', cursor: rows, writes: [] }));
