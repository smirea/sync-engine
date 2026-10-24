import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bearerToken, createSpace, defineSchema } from '@sync-engine/core';
import { durableDriver } from './src/driver.ts';
import { handleSync } from './src/worker.ts';

describe('handleSync', () => {
	const seen: Request[] = [];
	const namespace = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			fetch: (request: Request) => {
				seen.push(request);
				return Promise.resolve(Response.json({ space: id.name }));
			},
		}),
	} as unknown as DurableObjectNamespace;
	const options = { namespace, spaceId: 'demo', authorize: (request: Request) => bearerToken(request) === 'dev' };

	test('401 before the object is touched', async () => {
		const request = new Request('http://x/sync', { method: 'POST', headers: { authorization: 'Bearer nope' } });
		expect((await handleSync(request, options)).status).toBe(401);
		expect(seen).toHaveLength(0);
	});

	test('POST /sync reaches the stub for the named space with method, headers and body', async () => {
		const request = new Request('http://x/sync', {
			method: 'POST',
			headers: { authorization: 'Bearer dev', 'content-type': 'application/json' },
			body: '{"protocol":1}',
		});
		const response = await handleSync(request, options);
		expect(await response.json()).toEqual({ space: 'demo' });
		const forwarded = seen.pop()!;
		expect(forwarded.method).toBe('POST');
		expect(forwarded.url).toBe('http://x/sync');
		expect(forwarded.headers.get('authorization')).toBe('Bearer dev');
		expect(await forwarded.text()).toBe('{"protocol":1}');
	});

	test('GET /live authorizes through the subprotocol and passes the upgrade through', async () => {
		const request = new Request('http://x/live', {
			headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'sync-engine.v1, bearer.dev' },
		});
		expect((await handleSync(request, options)).status).toBe(200);
		const forwarded = seen.pop()!;
		expect(forwarded.method).toBe('GET');
		expect(forwarded.url).toBe('http://x/live');
		expect(forwarded.headers.get('upgrade')).toBe('websocket');
		expect(forwarded.headers.get('sec-websocket-protocol')).toBe('sync-engine.v1, bearer.dev');
	});
});

describe('durableDriver', () => {
	test('runs a space over the SqlStorage cursor shape', () => {
		const db = new Database(':memory:');
		const storage = {
			sql: {
				exec: (query: string, ...bindings: SQLQueryBindings[]) => ({ toArray: () => db.query(query).all(...bindings) }),
			},
			transactionSync<T>(fn: () => T): T {
				return db.transaction(fn)();
			},
		};
		const schema = defineSchema({
			tables: { notes: sqliteTable('notes', { id: text('id').primaryKey(), n: integer('n').notNull().default(0) }) },
		});
		const space = createSpace(durableDriver(storage as never), schema);
		space.migrate();
		const response = space.sync({
			protocol: 1,
			client: 'a',
			cursor: 0,
			writes: [{ seq: 1, table: 'notes', id: 'n1', op: 'put', values: { n: 2 } }],
		});
		expect(response).toEqual({
			head: 1,
			acked: 1,
			rejected: [],
			snapshot: true,
			rows: [{ table: 'notes', id: 'n1', deleted: 0, values: { id: 'n1', n: 2 } }],
		});
		expect(space.head()).toBe(1);
		expect(db.query('SELECT id, n FROM notes').all()).toEqual([{ id: 'n1', n: 2 }]);
	});
});
