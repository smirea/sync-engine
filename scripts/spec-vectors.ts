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
import type {
	Key,
	LocalOp,
	ModelState,
	PageVector,
	PulledVector,
	PullVector,
	Rows,
	Scenario,
	SparseRow,
	VectorWrite,
	Vectors,
	WriteVector,
} from '../spec/vectors.ts';

type Nat = number;
type NMap = { $: 'NNil' } | { $: 'NCon'; key: Nat; val: Nat; rest: NMap };
type RowKey = { $: 'RowKey'; table: Nat; id: Nat };
type KMap<V> = { $: 'KNil' } | { $: 'KCon'; key: RowKey; val: V; rest: KMap<V> };
type Maybe<V> = { $: 'None' } | { $: 'Some'; value: V };
type List<V> = { $: 'Nil' } | { $: 'Con'; head: V; tail: List<V> };
type Op = { $: 'Put'; row: NMap } | { $: 'Patch'; cols: NMap } | { $: 'Delete' };
type Write = { $: 'Write'; client: Nat; seq: Nat; op: Op; table: Nat; id: Nat };
type State = { $: 'State'; rows: KMap<NMap>; head: Nat; changes: KMap<Nat>; clients: NMap; horizon: Nat };
type Pulled = { $: 'Pulled'; key: RowKey; row: Maybe<NMap> };
type Pull = { $: 'Snapshot'; rows: KMap<NMap>; head: Nat } | { $: 'Delta'; items: List<Pulled>; head: Nat };
type Page = { $: 'Page'; items: List<Pulled>; next: Maybe<RowKey>; head: Nat };
type Client = { $: 'Client'; local: KMap<NMap>; cursor: Nat };
type EOp = { $: 'Inserted' } | { $: 'Updated'; col: Nat } | { $: 'Deleted' };
type Entry = { $: 'Entry'; seq: Nat; table: Nat; id: Nat; op: EOp };
type Model = {
	apply(s: State, w: Write): State;
	pull(s: State, cursor: Nat): Pull;
	applyPull(c: Client, p: Pull): Client;
	'applyPull.go'(items: List<Pulled>, local: KMap<NMap>): KMap<NMap>;
	compact(s: State, h: Nat): State;
	pullPage(s: State, after: Maybe<RowKey>, n: Nat): Page;
	collect(client: Nat, local: KMap<NMap>, outbox: List<Entry>): List<Write>;
	applyBatch(s: State, ws: List<Write>): State;
	'KMap.set'(m: KMap<NMap>, k: RowKey, v: NMap): KMap<NMap>;
	'KMap.del'(m: KMap<NMap>, k: RowKey): KMap<NMap>;
	'KMap.lookup'(m: KMap<NMap>, k: RowKey): Maybe<NMap>;
	'NMap.set'(m: NMap, k: Nat, v: Nat): NMap;
	'NMap.get'(m: NMap, k: Nat, d: Nat): Nat;
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
const COMPACT_AT = 20;
const PAGE_FROM = 18;
const PAGE_SIZE = 3;
const BATCH_OPS = 8;

const EMPTY: State = {
	$: 'State',
	rows: { $: 'KNil' },
	head: 0,
	changes: { $: 'KNil' },
	clients: { $: 'NNil' },
	horizon: 0,
};
const nmap = (entries: [Nat, Nat][]): NMap =>
	entries.reduceRight<NMap>((rest, [key, val]) => ({ $: 'NCon', key, val, rest }), { $: 'NNil' });
function list<V>(items: V[]): List<V> {
	return items.reduceRight<List<V>>((tail, head) => ({ $: 'Con', head, tail }), { $: 'Nil' });
}
const rowKey = (table: Nat, id: Nat): RowKey => ({ $: 'RowKey', table, id });

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
const key = (k: RowKey): Key => ({ table: tableName(k.table), id: String(k.id) });
const maybeKey = (m: Maybe<RowKey>): Key | null => (m.$ === 'Some' ? key(m.value) : null);
const sparse = (row: NMap): SparseRow => Object.fromEntries([...nEntries(row)].map(([c, v]) => [`c${c}`, v]));

function rows(m: KMap<NMap>): Rows {
	const out: Rows = {};
	for (const [k, row] of kEntries(m)) (out[tableName(k.table)] ??= {})[String(k.id)] = sparse(row);
	return out;
}

function state(s: State): ModelState {
	const changes: ModelState['changes'] = {};
	for (const [k, stamp] of kEntries(s.changes)) (changes[tableName(k.table)] ??= {})[String(k.id)] = stamp;
	return {
		head: s.head,
		rows: rows(s.rows),
		changes,
		clients: Object.fromEntries([...nEntries(s.clients)].map(([c, seq]) => [`client${c}`, seq])),
		horizon: s.horizon,
	};
}

const pulled = ({ key: k, row }: Pulled): PulledVector =>
	row.$ === 'Some' ? { ...key(k), deleted: 0, values: sparse(row.value) } : { ...key(k), deleted: 1 };
const liveRows = (m: KMap<NMap>): PulledVector[] =>
	[...kEntries(m)].map(([k, row]) => ({ ...key(k), deleted: 0, values: sparse(row) }));

function pull(s: State, cursor: Nat): PullVector {
	const result = model.pull(s, cursor);
	return result.$ === 'Snapshot'
		? { cursor, head: result.head, snapshot: true, rows: liveRows(result.rows) }
		: { cursor, head: result.head, snapshot: false, rows: [...items(result.items)].map(pulled) };
}

const write = (w: Write): WriteVector => {
	const base = { seq: w.seq, table: tableName(w.table), id: String(w.id) };
	return w.op.$ === 'Put'
		? { ...base, op: 'put', values: sparse(w.op.row) }
		: w.op.$ === 'Patch'
			? { ...base, op: 'patch', values: sparse(w.op.cols) }
			: { ...base, op: 'delete' };
};

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
	const sent: number[][] = Array.from({ length: CLIENTS }, () => []);
	let current = EMPTY;
	const states: State[] = [];
	const writes: VectorWrite[] = [];
	for (let i = 0; i < WRITES; i++) {
		const client = int(CLIENTS);
		const roll = random();
		let seq: number;
		const replays = sent[client]!;
		if (roll < 0.7 || !replays.length) seq = ++next[client]!;
		else if (roll < 0.85) seq = replays[int(replays.length)]!;
		else seq = next[client]! += 2;
		if (!replays.includes(seq)) replays.push(seq);
		const table = int(TABLES);
		const id = int(IDS);
		const kind = random();
		const op: Op =
			kind < 0.4
				? { $: 'Put', row: nmap(columns()) }
				: kind < 0.75
					? { $: 'Patch', cols: nmap(columns()) }
					: { $: 'Delete' };
		const w: Write = { $: 'Write', client, seq, op, table, id };
		current = model.apply(current, w);
		states.push(current);
		writes.push({ ...write(w), client: `client${client}`, state: state(current) });
	}
	const mid = states[Math.floor(WRITES / 2)]!;
	const local: Client = { $: 'Client', local: mid.rows, cursor: mid.head };
	const after = model.applyPull(local, model.pull(current, mid.head));

	// compaction: everything the first COMPACT_AT writes stamped is old enough to drop
	const horizon = states[COMPACT_AT - 1]!.head;
	const compacted = model.compact(current, horizon);
	const compactionPulls = [horizon - 1, horizon, current.head].filter(cursor => cursor >= 0);

	// batch: a fresh client edits a copy of the final rows, then its outbox goes up as one batch in first-seen order
	const batchClient = CLIENTS;
	let batchLocal = current.rows;
	const ops: LocalOp[] = [];
	const entries: Entry[] = [];
	const present = () => [...kEntries(batchLocal)].map(([k]) => k);
	for (let i = 0; i < BATCH_OPS; i++) {
		const kind = random();
		const existing = present();
		if (kind < 0.35 || !existing.length) {
			const absent = Array.from({ length: TABLES * IDS }, (_, n) => rowKey(Math.floor(n / IDS), n % IDS)).filter(
				k => model['KMap.lookup'](batchLocal, k).$ === 'None',
			);
			if (!absent.length) continue;
			const k = absent[int(absent.length)]!;
			const row = nmap(columns());
			batchLocal = model['KMap.set'](batchLocal, k, row);
			entries.push({ $: 'Entry', seq: entries.length + 1, table: k.table, id: k.id, op: { $: 'Inserted' } });
			ops.push({ op: 'insert', ...key(k), values: sparse(row) });
		} else if (kind < 0.8) {
			const k = existing[int(existing.length)]!;
			const row = (model['KMap.lookup'](batchLocal, k) as { value: NMap }).value;
			const col = int(COLUMNS);
			const value = (model['NMap.get'](row, col, 10) + 1 + int(9)) % 10;
			batchLocal = model['KMap.set'](batchLocal, k, model['NMap.set'](row, col, value));
			entries.push({ $: 'Entry', seq: entries.length + 1, table: k.table, id: k.id, op: { $: 'Updated', col } });
			ops.push({ op: 'update', ...key(k), col: `c${col}`, value });
		} else {
			const k = existing[int(existing.length)]!;
			batchLocal = model['KMap.del'](batchLocal, k);
			entries.push({ $: 'Entry', seq: entries.length + 1, table: k.table, id: k.id, op: { $: 'Deleted' } });
			ops.push({ op: 'delete', ...key(k) });
		}
	}
	const batchWrites = model.collect(batchClient, batchLocal, list(entries));
	const batched = model.applyBatch(current, batchWrites);

	// paging: pages of PAGE_SIZE while the writes after PAGE_FROM land, then a delta from the first page's head
	const pages: PageVector[] = [];
	let pageLocal: KMap<NMap> = { $: 'KNil' };
	let at = PAGE_FROM;
	let cursorKey: Maybe<RowKey> = { $: 'None' };
	for (;;) {
		const page = model.pullPage(states[at - 1]!, cursorKey, PAGE_SIZE);
		pages.push({
			at,
			after: maybeKey(cursorKey),
			head: page.head,
			rows: [...items(page.items)].map(pulled),
			next: maybeKey(page.next),
		});
		pageLocal = model['applyPull.go'](page.items, pageLocal);
		if (page.next.$ === 'None') break;
		cursorKey = page.next;
		if (at < WRITES) at += 1;
	}
	const firstHead = states[PAGE_FROM - 1]!.head;
	const settled = model.applyPull({ $: 'Client', local: pageLocal, cursor: firstHead }, model.pull(current, firstHead));

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
		compaction: {
			at: COMPACT_AT,
			horizon,
			state: state(compacted),
			pulls: compactionPulls.map(cursor => pull(compacted, cursor)),
		},
		batch: {
			client: `client${batchClient}`,
			local: rows(current.rows),
			ops,
			writes: [...items(batchWrites)].map(write),
			state: state(batched),
		},
		paging: {
			from: PAGE_FROM,
			size: PAGE_SIZE,
			pages,
			cursor: firstHead,
			final: { local: rows(settled.local), cursor: settled.cursor },
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
