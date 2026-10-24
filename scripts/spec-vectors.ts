/**
 * Builds the Bend model to `spec/sync.mjs`, drives seeded scenarios through it and writes `spec/vectors.json`, the
 * contract `packages/core/spec.test.ts` replays through the SQL core. Run with `bun run spec-vectors` after any change
 * to `spec/sync.bend`; the test fails on a stale `bend_sha256`.
 */
import { $ } from 'bun';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelState, PullVector, Rows, Scenario, SparseRow, VectorWrite, Vectors } from '../spec/vectors.ts';

type Nat = number;
type NMap = { $: 'NNil' } | { $: 'NCon'; key: Nat; val: Nat; rest: NMap };
type RowKey = { $: 'RowKey'; table: Nat; id: Nat };
type KMap<V> = { $: 'KNil' } | { $: 'KCon'; key: RowKey; val: V; rest: KMap<V> };
type Maybe<V> = { $: 'None' } | { $: 'Some'; value: V };
type List<V> = { $: 'Nil' } | { $: 'Con'; head: V; tail: List<V> };
type Op = { $: 'Put'; row: NMap } | { $: 'Patch'; cols: NMap } | { $: 'Delete' };
type Write = { $: 'Write'; client: Nat; seq: Nat; op: Op; table: Nat; id: Nat };
type State = { $: 'State'; rows: KMap<NMap>; head: Nat; changes: KMap<Nat>; clients: NMap };
type Pulled = { $: 'Pulled'; key: RowKey; row: Maybe<NMap> };
type Pull = { $: 'Tuple'; fst: List<Pulled>; snd: Nat };
type Client = { $: 'Client'; local: KMap<NMap>; cursor: Nat };
type Model = {
	apply(s: State, w: Write): State;
	pull(s: State, cursor: Nat): Pull;
	applyPull(c: Client, p: Pull): Client;
};

const root = join(import.meta.dir, '..');
const bendHome = process.env.BEND_HOME ?? join(homedir(), '.bend');
await $`${join(bendHome, 'bin', 'bend')} spec/sync.bend -o spec/sync.mjs`
	.cwd(root)
	.env({ ...process.env, BEND_HOME: bendHome, BEND_NO_TELEMETRY: '1' })
	.quiet();
const model = (await import(join(root, 'spec', 'sync.mjs'))).default as Model;

const TABLES = 2;
const IDS = 4;
const COLUMNS = 3;
const CLIENTS = 3;
const SCENARIOS = 20;
const WRITES = 30;

const nmap = (entries: [Nat, Nat][]): NMap =>
	entries.reduceRight<NMap>((rest, [key, val]) => ({ $: 'NCon', key, val, rest }), { $: 'NNil' });

function* nEntries(m: NMap): Generator<[Nat, Nat]> {
	for (let cur = m; cur.$ === 'NCon'; cur = cur.rest) yield [cur.key, cur.val];
}
function* kEntries<V>(m: KMap<V>): Generator<[RowKey, V]> {
	for (let cur = m; cur.$ === 'KCon'; cur = cur.rest) yield [cur.key, cur.val];
}
function* items<V>(l: List<V>): Generator<V> {
	for (let cur = l; cur.$ === 'Con'; cur = cur.tail) yield cur.head;
}

const tableName = (n: Nat) => `t${n}`;
const sparse = (row: NMap): SparseRow => Object.fromEntries([...nEntries(row)].map(([c, v]) => [`c${c}`, v]));

function rows(m: KMap<NMap>): Rows {
	const out: Rows = {};
	for (const [key, row] of kEntries(m)) (out[tableName(key.table)] ??= {})[String(key.id)] = sparse(row);
	return out;
}

function state(s: State): ModelState {
	const changes: ModelState['changes'] = {};
	for (const [key, stamp] of kEntries(s.changes)) (changes[tableName(key.table)] ??= {})[String(key.id)] = stamp;
	return {
		head: s.head,
		rows: rows(s.rows),
		changes,
		clients: Object.fromEntries([...nEntries(s.clients)].map(([c, seq]) => [`client${c}`, seq])),
	};
}

function pull(s: State, cursor: Nat): PullVector {
	const result = model.pull(s, cursor);
	return {
		cursor,
		head: result.snd,
		rows: [...items(result.fst)].map(({ key, row }) => {
			const table = tableName(key.table);
			const id = String(key.id);
			return row.$ === 'Some' ? { table, id, deleted: 0, values: sparse(row.value) } : { table, id, deleted: 1 };
		}),
	};
}

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function scenario(seed: number): Scenario {
	const random = mulberry32(seed);
	const int = (n: number) => Math.floor(random() * n);
	const columns = (): [Nat, Nat][] =>
		Array.from({ length: COLUMNS }, (_, c) => c)
			.filter(() => random() < 0.6)
			.map(c => [c, int(10)]);
	const next = Array.from({ length: CLIENTS }, () => 0);
	let current: State = { $: 'State', rows: { $: 'KNil' }, head: 0, changes: { $: 'KNil' }, clients: { $: 'NNil' } };
	const states: State[] = [];
	const writes: VectorWrite[] = [];
	for (let i = 0; i < WRITES; i++) {
		const client = int(CLIENTS);
		const roll = random();
		let seq: number;
		if (roll < 0.7) seq = ++next[client]!;
		else if (roll < 0.85) seq = int(next[client]! + 1);
		else seq = next[client]! += 2;
		const table = int(TABLES);
		const id = int(IDS);
		const kind = random();
		const op: Op =
			kind < 0.4
				? { $: 'Put', row: nmap(columns()) }
				: kind < 0.75
					? { $: 'Patch', cols: nmap(columns()) }
					: { $: 'Delete' };
		current = model.apply(current, { $: 'Write', client, seq, op, table, id });
		states.push(current);
		const base = { client: `client${client}`, seq, table: tableName(table), id: String(id), state: state(current) };
		writes.push(
			op.$ === 'Put'
				? { ...base, op: 'put', values: sparse(op.row) }
				: op.$ === 'Patch'
					? { ...base, op: 'patch', values: sparse(op.cols) }
					: { ...base, op: 'delete' },
		);
	}
	const mid = states[Math.floor(WRITES / 2)]!;
	const local: Client = { $: 'Client', local: mid.rows, cursor: mid.head };
	const pulled = model.pull(current, mid.head);
	const after = model.applyPull(local, pulled);
	return {
		name: `seed ${seed}`,
		writes,
		pulls: [0, Math.floor(current.head / 2), current.head].map(cursor => pull(current, cursor)),
		applyPull: {
			local: rows(mid.rows),
			cursor: mid.head,
			pull: pull(current, mid.head),
			result: { local: rows(after.local), cursor: after.cursor },
		},
	};
}

const vectors: Vectors = {
	bend_sha256: createHash('sha256')
		.update(readFileSync(join(root, 'spec', 'sync.bend')))
		.digest('hex'),
	scenarios: Array.from({ length: SCENARIOS }, (_, i) => scenario(i + 1)),
};
const out = join(root, 'spec', 'vectors.json');
writeFileSync(out, JSON.stringify(vectors));
console.log(`${out}: ${vectors.scenarios.length} scenarios, ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
