import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSqlite } from '../../bun-sqlite/src/index.ts';
import { createSyncClient } from '../../client/src/index.ts';
import { schema } from './schema.ts';

const port = freePort();
const server = `127.0.0.1:${port}`;
const state = mkdtempSync(join(tmpdir(), 'sync-engine-smoke-'));
const log: string[] = [];
const wrangler = Bun.spawn(
	[
		join(import.meta.dir, '../../../node_modules/.bin/wrangler'),
		'dev',
		'--config',
		join(import.meta.dir, 'wrangler.jsonc'),
		'--ip',
		'127.0.0.1',
		'--port',
		String(port),
		'--persist-to',
		state,
	],
	{
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { PATH: Bun.env.PATH, HOME: Bun.env.HOME, WRANGLER_SEND_METRICS: 'false' },
	},
);
void collect(wrangler.stdout);
void collect(wrangler.stderr);

try {
	const booted = performance.now();
	await ready();
	console.log(
		`wrangler dev answered after ${(performance.now() - booted).toFixed(0)} ms, ${log.join('').match(/Ready on \S+/)?.[0] ?? 'no "Ready on" line yet'}`,
	);
	const a = peer();
	const b = peer();
	const unauthorized = await fetch(`http://${server}/sync`, { method: 'POST', body: '{}' });
	assert(unauthorized.status === 401, `no token gets 401, got ${unauthorized.status}`);

	b.client.start();
	await until(() => b.client.status().live && !b.client.status().syncing, 'b live socket');
	assert(b.client.status().cursor === 0, `b starts at cursor 0, got ${b.client.status().cursor}`);

	const arrived = new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('b saw no change within 10s')), 10_000);
		b.client.onChange(tables => {
			if (!tables.has('todos') || b.rows().length === 0) return;
			clearTimeout(timer);
			resolve(performance.now());
		});
	});
	a.db.exec("INSERT INTO todos (id, title) VALUES ('t1', 'from a')");
	const started = performance.now();
	a.client.markDirty();
	const finished = await arrived;
	const expected = [{ id: 't1', title: 'from a', done: 0 }];
	assert(JSON.stringify(a.rows()) === JSON.stringify(expected), `a holds ${JSON.stringify(a.rows())}`);
	assert(JSON.stringify(b.rows()) === JSON.stringify(expected), `b holds ${JSON.stringify(b.rows())}`);
	assert(a.client.status().pending === 0, `a cleared its outbox, pending ${a.client.status().pending}`);
	console.log(
		`write-to-other-client latency: ${(finished - started).toFixed(1)} ms (markDirty on a, 100 ms throttle included, to onChange on b)`,
	);
	console.log('a rows:', JSON.stringify(a.rows()));
	console.log('b rows:', JSON.stringify(b.rows()));
	b.client.stop();
	await stop();
	process.exit(0);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	console.error(log.join(''));
	await stop();
	process.exit(1);
}

function assert(ok: boolean, what: string) {
	if (!ok) throw new Error(what);
}

function freePort() {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	return port;
}

async function collect(stream: ReadableStream<Uint8Array>) {
	for await (const chunk of stream) log.push(new TextDecoder().decode(chunk));
}

async function ready() {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (wrangler.exitCode !== null) throw new Error(`wrangler exited with ${wrangler.exitCode}`);
		try {
			await fetch(`http://${server}/`);
			return;
		} catch {
			await Bun.sleep(200);
		}
	}
	throw new Error('wrangler dev did not answer within 60s');
}

async function stop() {
	wrangler.kill('SIGINT');
	const exited = await Promise.race([wrangler.exited, Bun.sleep(5000).then(() => null)]);
	if (exited === null) wrangler.kill('SIGKILL');
	rmSync(state, { recursive: true, force: true });
}

function peer() {
	const db = bunSqlite(':memory:');
	const client = createSyncClient({ driver: db, schema, endpoint: `http://${server}`, token: 'dev' });
	client.migrate();
	return { db, client, rows: () => db.exec('SELECT id, title, done FROM todos ORDER BY id') };
}

async function until(check: () => boolean, what: string) {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`${what} did not happen within 10s`);
		await Bun.sleep(50);
	}
}
