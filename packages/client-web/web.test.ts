import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from 'playwright';
import type { SqlDriver } from '../core/src/index.ts';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import { serve } from '../bun-server/src/index.ts';
import { createSyncClient } from '../client/src/index.ts';
import type { QueryResult, WebSyncStatus } from './src/index.ts';
import { schema } from './test/schema.ts';

type Note = { id: string; title: string; done: number };
type Tab = {
	db: {
		exec(sql: string): Promise<QueryResult>;
		batch(statements: { sql: string; params: unknown[] }[]): Promise<unknown>;
		setToken(token: string | null): Promise<void>;
	};
	changes: { tables: string[]; at: number }[];
	statuses: WebSyncStatus[];
	now(): number;
	insert(id: string, title: string): Promise<unknown>;
	rows(): Promise<Note[]>;
	status(): Promise<WebSyncStatus>;
};
declare const window: Window & { tab: Tab };

const browsers: [string, BrowserType][] = [
	['chromium', chromium],
	['webkit', webkit],
];
for (const [name, type] of browsers) {
	if (!existsSync(type.executablePath()))
		throw new Error(`${name} is not installed for Playwright; run: bunx playwright install chromium webkit`);
}

async function until(condition: () => Promise<boolean> | boolean, timeout = 10_000) {
	const deadline = performance.now() + timeout;
	while (!(await condition())) {
		if (performance.now() > deadline) throw new Error('timed out waiting for condition');
		await Bun.sleep(20);
	}
}

const insert = (db: SqlDriver, id: string, title: string) =>
	db.exec('INSERT INTO notes (id, title) VALUES (?, ?)', [id, title]);

function bunPeer(endpoint: string) {
	const db = bunSqlite(':memory:');
	const client = createSyncClient({ driver: db, schema, endpoint });
	client.migrate();
	return { db, client, rows: () => db.exec('SELECT * FROM notes ORDER BY id') as Note[] };
}

describe.each(browsers)('%s', (name, browserType) => {
	const cleanup: (() => unknown)[] = [];
	const logs: string[] = [];
	let base = '';
	let endpoint = '';
	let context: BrowserContext;

	const persistentContext = async () => {
		const ctx = await browserType.launchPersistentContext(mkdtempSync(join(tmpdir(), 'sync-web-')));
		cleanup.push(() => ctx.close());
		return ctx;
	};

	const open = async (ctx: BrowserContext, search = '') => {
		const page = await ctx.newPage();
		page.on('console', entry => logs.push(`[${name} console] ${entry.text()}`));
		page.on('pageerror', error => logs.push(`[${name} pageerror] ${error.message}`));
		await page.goto(base + search);
		await page.waitForFunction(() => 'tab' in window);
		return page;
	};
	const rows = (page: Page) => page.evaluate(() => window.tab.rows());
	const status = (page: Page) => page.evaluate(() => window.tab.status());
	const changes = (page: Page) => page.evaluate(() => window.tab.changes);

	beforeAll(async () => {
		const server = serve({ driver: bunSqlite(':memory:'), schema, authorize: () => true, port: 0 });
		cleanup.push(() => server.stop(true));
		endpoint = `http://127.0.0.1:${server.port}`;

		const outdir = mkdtempSync(join(tmpdir(), 'sync-web-build-'));
		const built = await Bun.build({
			entrypoints: [join(import.meta.dir, 'test/page.ts'), join(import.meta.dir, 'test/worker.ts')],
			outdir,
			target: 'browser',
			format: 'esm',
			define: { __ENDPOINT__: JSON.stringify(endpoint) },
		});
		if (!built.success) throw new Error(built.logs.map(String).join('\n'));
		cpSync(
			join(import.meta.dir, '../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'),
			join(outdir, 'sqlite3.wasm'),
		);

		const files = Bun.serve({
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === '/') {
					return new Response('<!doctype html><script type="module" src="/page.js"></script>', {
						headers: { 'content-type': 'text/html' },
					});
				}
				const file = Bun.file(join(outdir, path));
				return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
			},
		});
		cleanup.push(() => files.stop(true));
		base = `http://127.0.0.1:${files.port}/`;
		context = await persistentContext();
	});

	afterAll(async () => {
		for (const fn of cleanup.splice(0).toReversed()) await fn();
	});

	test('two tabs, a Bun peer, a reload, a failover, a batch, and a lone tab', async () => {
		try {
			const a = await open(context);
			await until(async () => (await status(a)).live);
			const b = await open(context);
			await status(b);

			const wroteAt = await a.evaluate(async () => {
				const at = window.tab.now();
				await window.tab.insert('n1', 'one');
				return at;
			});
			await until(async () => (await changes(b)).length > 0);
			const [first] = await changes(b);
			expect(first!.tables).toEqual(['notes']);
			console.log(`latency ${name} A→B ${(first!.at - wroteAt).toFixed(1)} ms`);
			expect(await rows(b)).toEqual([{ id: 'n1', title: 'one', done: 0 }]);

			const peer = bunPeer(endpoint);
			await until(async () => (await peer.client.sync(), peer.rows().length === 1));
			expect(peer.rows()).toEqual([{ id: 'n1', title: 'one', done: 0 }]);
			insert(peer.db, 'n2', 'from bun');
			const beforeN2 = (await changes(b)).length;
			await peer.client.sync();
			const two = [
				{ id: 'n1', title: 'one', done: 0 },
				{ id: 'n2', title: 'from bun', done: 0 },
			];
			await until(async () => (await rows(a)).length === 2 && (await rows(b)).length === 2);
			expect(await rows(a)).toEqual(two);
			expect(await rows(b)).toEqual(two);
			expect((await changes(b)).slice(beforeN2).some(change => change.tables.includes('notes'))).toBe(true);

			const before = await status(a);
			expect(before.host).toBe(true);
			expect((await status(b)).host).toBe(false);
			await a.reload();
			await a.waitForFunction(() => 'tab' in window);
			expect(await rows(a)).toEqual(two);
			const after = await status(a);
			expect(after.clientId).toBe(before.clientId);

			const hosts = [await status(a), await status(b)].filter(s => s.host).length;
			expect(hosts).toBe(1);
			const [host, remaining] = (await status(a)).host ? [a, b] : [b, a];
			const closedAt = performance.now();
			await host.close();
			await remaining.evaluate(() => window.tab.insert('n3', 'after failover'));
			console.log(`failover ${name} close→write ${(performance.now() - closedAt).toFixed(0)} ms`);
			await until(async () => (await peer.client.sync(), peer.rows().length === 3), 5000);
			expect(peer.rows().at(-1)).toEqual({ id: 'n3', title: 'after failover', done: 0 });
			expect((await status(remaining)).host).toBe(true);

			const refused = await remaining.evaluate(() =>
				window.tab.db.exec('BEGIN').then(
					() => null,
					(error: Error & { code: string }) => ({ name: error.name, code: error.code }),
				),
			);
			expect(refused).toEqual({ name: 'SyncWebError', code: 'explicit-transaction' });
			const codes = await remaining.evaluate(async () => {
				const code = (promise: Promise<unknown>) =>
					promise.then(
						() => null,
						(error: { code: string }) => error.code,
					);
				return [
					await code(window.tab.db.exec('BEGIN; INSERT INTO missing VALUES (1)')),
					await code(window.tab.db.exec('BEGIN')),
				];
			});
			expect(codes).toEqual(['sql', 'explicit-transaction']);
			const fired = await remaining.evaluate(async () => {
				const count = window.tab.changes.length;
				await window.tab.db.batch([
					{ sql: 'INSERT INTO notes (id, title) VALUES (?, ?)', params: ['n4', 'batch one'] },
					{ sql: 'INSERT INTO notes (id, title) VALUES (?, ?)', params: ['n5', 'batch two'] },
				]);
				return window.tab.changes.slice(count);
			});
			expect(fired).toHaveLength(1);
			expect(fired[0]!.tables).toEqual(['notes']);
			expect((await rows(remaining)).map(note => note.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);

			const lone = await open(await persistentContext());
			await until(async () => (await status(lone)).live);
			await until(async () => (await rows(lone)).length === 5);
			await lone.evaluate(() => window.tab.insert('n6', 'lone tab'));
			await until(async () => (await peer.client.sync(), peer.rows().length === 6), 5000);
			expect(peer.rows().at(-1)).toEqual({ id: 'n6', title: 'lone tab', done: 0 });
			peer.client.stop();
		} catch (error) {
			console.log(logs.join('\n'));
			throw error;
		}
	}, 60_000);

	test('a tab that joins after setToken inherits the token and keeps syncing as host', async () => {
		try {
			const ctx = await persistentContext();
			const a = await open(ctx, '?wait');
			expect((await status(a)).live).toBe(false);
			await a.evaluate(() => window.tab.db.setToken('session'));
			await until(async () => (await status(a)).live);
			await until(async () => (await a.evaluate(() => window.tab.statuses.length)) > 0);
			const b = await open(ctx, '?wait');
			await status(b);
			await a.close();
			await until(async () => (await status(b)).host);
			await until(async () => (await status(b)).live);
		} catch (error) {
			console.log(logs.join('\n'));
			throw error;
		}
	}, 30_000);
});
