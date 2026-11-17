import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
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

// The browser-runtime exception that the `tests` skill allows: the web client's sync runs only in a page, a worker
// and OPFS. These cases drive that API through `window.tab`, never the UI, and run as their own CI job, never in a hook.

type Note = { id: string; title: string; done: number };
type Tab = {
	db: {
		exec(sql: string): Promise<QueryResult>;
		batch(statements: { sql: string; params: unknown[] }[]): Promise<unknown>;
		setToken(token: string | null): Promise<void>;
	};
	changes: { tables: string[] }[];
	statuses: WebSyncStatus[];
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

const note = (id: string, title: string): Note => ({ id, title, done: 0 });
const insert = (db: SqlDriver, id: string, title: string) =>
	db.exec('INSERT INTO notes (id, title) VALUES (?, ?)', [id, title]);

describe.each(browsers)('%s', (name, browserType) => {
	const cleanup: (() => unknown)[] = [];
	const logs: string[] = [];
	let base = '';
	let stopFiles = () => {};

	const rows = (page: Page) => page.evaluate(() => window.tab.rows());
	const status = (page: Page) => page.evaluate(() => window.tab.status());
	const changes = (page: Page) => page.evaluate(() => window.tab.changes);

	/** A sync server of its own, a fresh browser profile on it, and a Bun client of the same server. */
	async function setup() {
		const server = serve({ driver: bunSqlite(':memory:'), schema, authorize: () => true, port: 0 });
		cleanup.push(() => server.stop(true));
		const endpoint = `http://127.0.0.1:${server.port}`;
		const context = await browserType.launchPersistentContext(mkdtempSync(join(tmpdir(), 'sync-web-')));
		cleanup.push(() => context.close());
		const open = async (ctx: BrowserContext = context, query = '') => {
			const page = await ctx.newPage();
			page.on('console', entry => logs.push(`[${name} console] ${entry.text()}`));
			page.on('pageerror', error => logs.push(`[${name} pageerror] ${error.message}`));
			await page.goto(`${base}?endpoint=${encodeURIComponent(endpoint)}${query}`);
			await page.waitForFunction(() => 'tab' in window);
			return page;
		};
		const db = bunSqlite(':memory:');
		const peer = createSyncClient({ driver: db, schema, endpoint });
		peer.migrate();
		const peerRows = async () => {
			await peer.sync();
			return db.exec('SELECT * FROM notes ORDER BY id') as Note[];
		};
		return { context, open, peer: { db, client: peer, rows: peerRows } };
	}

	beforeAll(async () => {
		const outdir = mkdtempSync(join(tmpdir(), 'sync-web-build-'));
		const built = await Bun.build({
			entrypoints: [join(import.meta.dir, 'test/page.ts'), join(import.meta.dir, 'test/worker.ts')],
			outdir,
			target: 'browser',
			format: 'esm',
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
		base = `http://127.0.0.1:${files.port}/`;
		stopFiles = () => files.stop(true);
	});
	afterAll(() => stopFiles());

	afterEach(async () => {
		logs.length = 0;
		for (const fn of cleanup.splice(0).toReversed()) await fn();
	});

	/** A failing case prints what the pages logged, which is otherwise lost with the browser. */
	const logged = (fn: () => Promise<void>) => async () => {
		try {
			await fn();
		} catch (error) {
			console.log(logs.join('\n'));
			throw error;
		}
	};

	test(
		'one tab hosts the database, and a write in any tab reaches the other tabs and a Bun client',
		logged(async () => {
			const { open, peer } = await setup();
			const a = await open();
			await until(async () => (await status(a)).live);
			const b = await open();
			expect([(await status(a)).host, (await status(b)).host]).toEqual([true, false]);

			await a.evaluate(() => window.tab.insert('n1', 'one'));
			await until(async () => (await changes(b)).length > 0);
			expect((await changes(b))[0]!.tables).toEqual(['notes']);
			expect(await rows(b)).toEqual([note('n1', 'one')]);
			await until(async () => (await peer.rows()).length === 1);

			insert(peer.db, 'n2', 'from bun');
			await peer.client.sync();
			const two = [note('n1', 'one'), note('n2', 'from bun')];
			await until(async () => (await rows(a)).length === 2 && (await rows(b)).length === 2);
			expect(await rows(a)).toEqual(two);
			expect(await rows(b)).toEqual(two);
		}),
		30_000,
	);

	test(
		'a reloaded tab keeps its rows and its client id',
		logged(async () => {
			const { open } = await setup();
			const a = await open();
			await a.evaluate(() => window.tab.insert('n1', 'kept'));
			const before = await status(a);
			await a.reload();
			await a.waitForFunction(() => 'tab' in window);
			expect(await rows(a)).toEqual([note('n1', 'kept')]);
			expect((await status(a)).clientId).toBe(before.clientId);
		}),
		30_000,
	);

	test(
		'closing the host tab hands the database to a remaining tab, whose writes still sync',
		logged(async () => {
			const { open, peer } = await setup();
			const a = await open();
			await until(async () => (await status(a)).live);
			const b = await open();
			await status(b);
			await a.close();
			await b.evaluate(() => window.tab.insert('n1', 'after failover'));
			await until(async () => (await peer.rows()).length === 1);
			expect(await peer.rows()).toEqual([note('n1', 'after failover')]);
			expect((await status(b)).host).toBe(true);
		}),
		30_000,
	);

	test(
		'an explicit transaction is refused, and a batch commits as one change',
		logged(async () => {
			const { open } = await setup();
			const a = await open();
			const codes = await a.evaluate(async () => {
				const code = (promise: Promise<unknown>) =>
					promise.then(
						() => null,
						(error: Error & { code: string }) => `${error.name}:${error.code}`,
					);
				return [
					await code(window.tab.db.exec('BEGIN')),
					await code(window.tab.db.exec('BEGIN; INSERT INTO missing VALUES (1)')),
					await code(window.tab.db.exec('BEGIN')),
				];
			});
			expect(codes).toEqual([
				'SyncWebError:explicit-transaction',
				'SyncWebError:sql',
				'SyncWebError:explicit-transaction',
			]);
			const fired = await a.evaluate(async () => {
				const count = window.tab.changes.length;
				await window.tab.db.batch([
					{ sql: 'INSERT INTO notes (id, title) VALUES (?, ?)', params: ['n1', 'batch one'] },
					{ sql: 'INSERT INTO notes (id, title) VALUES (?, ?)', params: ['n2', 'batch two'] },
				]);
				return window.tab.changes.slice(count);
			});
			expect(fired.map(change => change.tables)).toEqual([['notes']]);
			expect((await rows(a)).map(row => row.id)).toEqual(['n1', 'n2']);
		}),
		30_000,
	);

	test(
		'a tab that joins after setToken inherits the token and keeps syncing as host',
		logged(async () => {
			const { context, open } = await setup();
			const a = await open(context, '&wait');
			expect((await status(a)).live).toBe(false);
			await a.evaluate(() => window.tab.db.setToken('session'));
			await until(async () => (await status(a)).live);
			await until(async () => (await a.evaluate(() => window.tab.statuses.length)) > 0);
			const b = await open(context, '&wait');
			await status(b);
			await a.close();
			await until(async () => (await status(b)).host);
			await until(async () => (await status(b)).live);
		}),
		30_000,
	);
});
