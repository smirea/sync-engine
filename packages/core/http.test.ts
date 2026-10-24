import { describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '@sync-engine/bun-sqlite';
import { bearerToken, createSpace, defineSchema, handleSync } from './src/index.ts';

const schema = defineSchema({
	tables: { notes: sqliteTable('notes', { id: text('id').primaryKey(), n: integer('n').notNull().default(0) }) },
});
const space = createSpace(bunSqlite(':memory:'), schema);
space.migrate();
const post = (body: string) => handleSync(space, new Request('http://x/sync', { method: 'POST', body }));

describe('handleSync', () => {
	test('answers the sync response with 200', async () => {
		const response = await post(
			JSON.stringify({
				protocol: 1,
				client: 'a',
				cursor: 0,
				writes: [{ seq: 1, table: 'notes', id: 'n1', op: 'put', values: { n: 2 } }],
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			head: 1,
			acked: 1,
			rejected: [],
			snapshot: true,
			rows: [{ table: 'notes', id: 'n1', deleted: 0, values: { id: 'n1', n: 2 } }],
		});
	});

	test('426 for another protocol, before the shape is checked', async () => {
		expect((await post(JSON.stringify({ protocol: 2, writes: 'nope' }))).status).toBe(426);
		expect((await post(JSON.stringify({ clientId: 'old', cursor: 0 }))).status).toBe(426);
	});

	test('400 for a body that is not the request shape', async () => {
		expect((await post('{not json')).status).toBe(400);
		expect((await post('[1]')).status).toBe(400);
		const response = await post(JSON.stringify({ protocol: 1, client: 'a', cursor: -1, writes: [] }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: '✖ Too small: expected number to be >=0\n  → at cursor' });
		expect(
			(
				await post(
					JSON.stringify({
						protocol: 1,
						client: 'a',
						cursor: 0,
						writes: [{ seq: 1, table: 'notes', id: 'x', op: 'upsert' }],
					}),
				)
			).status,
		).toBe(400);
	});
});

describe('bearerToken', () => {
	test('reads the Authorization header or the WebSocket subprotocol', () => {
		expect(bearerToken(new Request('http://x', { headers: { authorization: 'Bearer abc' } }))).toBe('abc');
		expect(
			bearerToken(new Request('http://x', { headers: { 'sec-websocket-protocol': 'sync-engine.v1, bearer.t0k' } })),
		).toBe('t0k');
		expect(bearerToken(new Request('http://x', { headers: { authorization: 'Basic abc' } }))).toBe(null);
		expect(bearerToken(new Request('http://x'))).toBe(null);
	});
});
