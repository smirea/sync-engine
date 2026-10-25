/**
 * Two-simulator sync measurements for a-better-me against a local Bun server.
 *
 *   ./serve.sh [pageSize] [retentionMs] [compactEveryMs]              the worktree server; run it as a background task
 *   bun measure.ts state <udid>...                                    cursor, outbox, after, row counts per app and server
 *   bun measure.ts snapshot <udid>...                                 wait until each app finished its first download; count pages seen
 *   bun measure.ts pause <udid> <serverPid>                           SIGSTOP the server once the app has its first page (kill -CONT to resume)
 *   bun measure.ts latency <writer> <reader> [table=settings]         wait for the table to change on writer, time until reader matches
 *   bun measure.ts outage <writer> <reader> [table=settings]          same with the server down; from the first /status 200 after you
 *                                                                     start it, time until reader matches
 *   bun measure.ts deletion <writer> <reader> [table=api_tokens]      wait for a row to vanish on writer, time until reader dropped it, then
 *                                                                     report the server tombstone and _log state
 *   bun measure.ts compare <udid>...                                  per-table row hashes of every app and the server, must agree
 *
 * All polling is every 10 ms through read-only bun:sqlite handles on the app files and the server file.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';

const WORKTREE = '/Users/stefan/code/a-better-me-v2';
const SERVER_DB = join(WORKTREE, '.data/a-better-me-v2.sqlite');
const SERVER_URL = env.SERVER_URL ?? 'http://127.0.0.1:16151';
const hasServerDb = () => !env.SERVER_URL && existsSync(SERVER_DB);
const BUNDLE = 'com.stefan.a-better-me';
const TABLES = [
	'workout_templates',
	'workout_sessions',
	'custom_exercises',
	'exercise_settings',
	'settings',
	'programs',
	'gym_profiles',
	'body_weights',
	'api_tokens',
];
const POLL_MS = 10;

const sh = (cmd: string[]) => Bun.spawnSync(cmd).stdout.toString().trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();

function appDb(udid: string): string {
	const container = sh(['xcrun', 'simctl', 'get_app_container', udid, BUNDLE, 'data']);
	if (!container) throw new Error(`no app container on ${udid}`);
	return join(container, 'Library/Application Support/a-better-me/a-better-me.sqlite');
}

async function waitFor(path: string, timeoutMs = 60_000) {
	const started = now();
	while (!existsSync(path)) {
		if (now() - started > timeoutMs) throw new Error(`missing ${path}`);
		await sleep(POLL_MS);
	}
}

function open(path: string): Database {
	if (!existsSync(path)) throw new Error(`missing ${path}`);
	return new Database(path, { readonly: true });
}

/** Freezes the server the moment `udid` has its first page, so the "Downloading…" row can be screenshotted. */
async function pause([udid, pid]: string[]) {
	const path = appDb(udid!);
	await waitFor(path);
	const db = open(path);
	const migrated = () => {
		try {
			return meta(db, 'after') != null;
		} catch {
			return false;
		}
	};
	const ms = await until('first page on the app', migrated);
	process.kill(Number(pid), 'SIGSTOP');
	console.log(
		`server ${pid} stopped ${ms.toFixed(0)} ms after the database appeared, after=${meta(db, 'after')} rows so far: ${TABLES.map(t => count(db, t)).reduce((a, b) => a + b, 0)}`,
	);
}

const one = <T>(db: Database, sql: string, ...params: unknown[]) => db.query(sql).get(...(params as never[])) as T;
const all = <T>(db: Database, sql: string, ...params: unknown[]) => db.query(sql).all(...(params as never[])) as T[];
const meta = (db: Database, key: string) =>
	one<{ value: unknown } | null>(db, 'SELECT value FROM _meta WHERE key = ?', key)?.value;
const count = (db: Database, table: string) => one<{ n: number }>(db, `SELECT count(*) AS n FROM "${table}"`).n;
const ids = (db: Database, table: string) =>
	new Set(all<{ id: string }>(db, `SELECT id FROM "${table}"`).map(r => r.id));

function hashes(db: Database, tables = TABLES): Record<string, string> {
	const out: Record<string, string> = {};
	for (const table of tables) {
		const rows = all<Record<string, unknown>>(db, `SELECT * FROM "${table}" ORDER BY id`);
		const text = JSON.stringify(
			rows.map(r => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)))),
		);
		out[table] = `${rows.length}:${new Bun.CryptoHasher('md5').update(text).digest('hex').slice(0, 8)}`;
	}
	return out;
}

async function until(label: string, check: () => boolean, timeoutMs = 120_000): Promise<number> {
	const started = now();
	while (!check()) {
		if (now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
		await sleep(POLL_MS);
	}
	return now() - started;
}

async function serverUp(): Promise<boolean> {
	try {
		return (await fetch(`${SERVER_URL}/status`)).ok;
	} catch {
		return false;
	}
}

function state(udids: string[]) {
	for (const udid of udids) {
		const db = open(appDb(udid));
		const counts = TABLES.map(t => `${t}=${count(db, t)}`).join(' ');
		console.log(
			`${udid.slice(0, 8)} cursor=${meta(db, 'cursor')} after=${meta(db, 'after') ?? '-'} outbox=${count(db, '_outbox')} ${counts}`,
		);
	}
	if (hasServerDb()) {
		const db = open(SERVER_DB);
		const counts = TABLES.map(t => `${t}=${count(db, t)}`).join(' ');
		const tombstones = one<{ n: number }>(db, 'SELECT count(*) AS n FROM _changes WHERE deleted = 1').n;
		console.log(
			`server head=${meta(db, 'head')} horizon=${meta(db, 'horizon')} log=${count(db, '_log')} tombstones=${tombstones} ${counts}`,
		);
	}
}

async function snapshot(udids: string[]) {
	for (const u of udids) await waitFor(appDb(u));
	const dbs = udids.map(u => [u, open(appDb(u))] as const);
	const pages = new Map(udids.map(u => [u, new Set<string>()]));
	const ms = await until('every app has cursor > 0 and no snapshot in progress', () => {
		let done = true;
		for (const [u, db] of dbs) {
			const after = meta(db, 'after');
			if (after != null) pages.get(u)!.add(String(after));
			if (!(Number(meta(db, 'cursor')) > 0) || after != null) done = false;
		}
		return done;
	});
	for (const [u, db] of dbs) {
		console.log(
			`${u.slice(0, 8)} converged after ${ms.toFixed(0)} ms, cursor=${meta(db, 'cursor')}, distinct _meta.after values seen while polling: ${pages.get(u)!.size}`,
		);
	}
	if (hasServerDb()) compare(udids);
	else
		console.log(
			`no local server file; app hashes: ${udids
				.map(
					u =>
						`${u.slice(0, 8)} ${Object.entries(hashes(open(appDb(u))))
							.map(([t, h]) => `${t}=${h}`)
							.join(' ')}`,
				)
				.join(' | ')}`,
		);
}

function compare(udids: string[]) {
	const server = hashes(open(SERVER_DB));
	let ok = true;
	for (const udid of udids) {
		const app = hashes(open(appDb(udid)));
		const diff = TABLES.filter(t => app[t] !== server[t]);
		if (diff.length) ok = false;
		console.log(
			`${udid.slice(0, 8)} ${diff.length ? `DIFFERS on ${diff.map(t => `${t} app=${app[t]} server=${server[t]}`).join(', ')}` : 'matches the server on all 9 tables'}`,
		);
	}
	console.log(
		`server ${Object.entries(server)
			.map(([t, h]) => `${t}=${h}`)
			.join(' ')}`,
	);
	if (!ok) process.exitCode = 1;
}

const tableHash = (db: Database, table: string) => hashes(db, [table])[table]!;

async function change(writer: Database, reader: Database, table: string) {
	const before = tableHash(writer, table);
	console.log(`watching ${table} on the writer (${before}); make the write in the app now`);
	await until('a change on the writer', () => tableHash(writer, table) !== before, 600_000);
	const t0 = now();
	const after = tableHash(writer, table);
	console.log(`writer ${table} is now ${after} (outbox=${count(writer, '_outbox')})`);
	return { t0, after, arrived: () => tableHash(reader, table) === after };
}

async function latency([w, r, table = 'settings']: string[]) {
	const writer = open(appDb(w!));
	const reader = open(appDb(r!));
	const { t0, after, arrived } = await change(writer, reader, table);
	await until('reader matches the writer', arrived);
	console.log(
		`RESULT latency ${table}: reader reached ${after} ${(now() - t0).toFixed(0)} ms after the writer's database changed`,
	);
}

async function outage([w, r, table = 'settings']: string[]) {
	if (await serverUp()) throw new Error('stop the server first');
	const writer = open(appDb(w!));
	const reader = open(appDb(r!));
	const { after, arrived } = await change(writer, reader, table);
	await until('the write is queued in the outbox', () => count(writer, '_outbox') > 0, 5000);
	console.log(
		`change queued offline, outbox=${count(writer, '_outbox')}; start the server now (serve.sh in the background)`,
	);
	while (!(await serverUp())) await sleep(POLL_MS);
	const tUp = now();
	console.log('server /status answered');
	if (hasServerDb()) {
		const toServer = await until('server matches the writer', () => tableHash(open(SERVER_DB), table) === after);
		console.log(`server reached ${after} ${toServer.toFixed(0)} ms after /status first answered`);
	}
	let drained: number | null = null;
	await until('reader matches the writer', () => {
		if (drained == null && count(writer, '_outbox') === 0) drained = now() - tUp;
		return arrived();
	});
	console.log(
		`writer outbox empty (push acked) ${drained == null ? 'after the reader matched' : `${drained.toFixed(0)} ms after /status first answered`}`,
	);
	console.log(
		`RESULT outage ${table}: reader reached ${after} ${(now() - tUp).toFixed(0)} ms after the server came back`,
	);
}

async function deletion([w, r, table = 'api_tokens']: string[]) {
	const writer = open(appDb(w!));
	const reader = open(appDb(r!));
	const before = ids(writer, table);
	let id = '';
	console.log(`watching ${table} on the writer (${before.size} rows); delete a row in the app now`);
	await until(
		'a row vanished on the writer',
		() => {
			const current = ids(writer, table);
			for (const candidate of before) if (!current.has(candidate)) return ((id = candidate), true);
			return false;
		},
		600_000,
	);
	const t0 = now();
	let snapshotPages = 0;
	await until('reader dropped the row', () => {
		if (meta(reader, 'after') != null) snapshotPages++;
		return !ids(reader, table).has(id);
	});
	console.log(
		`RESULT deletion ${table} ${id}: reader dropped it ${(now() - t0).toFixed(0)} ms after the writer did; reader path: ${snapshotPages ? `paged snapshot (${snapshotPages} polls saw _meta.after)` : 'delta'}`,
	);
	if (!hasServerDb()) return;
	const server = open(SERVER_DB);
	const tombstone = one<{ n: number }>(server, 'SELECT count(*) AS n FROM _changes WHERE id = ? AND deleted = 1', id).n;
	console.log(
		`server right after: tombstone rows for ${id}=${tombstone} _log=${count(server, '_log')} horizon=${meta(server, 'horizon')} head=${meta(server, 'head')}`,
	);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => unknown> = {
	state,
	snapshot,
	pause,
	latency,
	outage,
	deletion,
	compare,
};
const run = commands[command ?? ''];
if (!run) throw new Error(`unknown command ${command}`);
await run(rest);
