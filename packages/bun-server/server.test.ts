import { afterAll, describe, expect, test } from 'bun:test';
import { bearerToken, defineSchema, LIVE_PROTOCOL } from '../core/src/index.ts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import { serve } from './src/index.ts';

const schema = defineSchema({
	tables: { notes: sqliteTable('notes', { id: text('id').primaryKey(), n: integer('n').notNull().default(0) }) },
});
const server = serve({
	driver: bunSqlite(':memory:'),
	schema,
	authorize: request => bearerToken(request) === 't0k',
	port: 0,
});
afterAll(() => server.stop(true));
// The DOM lib's WebSocket type shadows Bun's constructor overload that takes headers.
const HeaderWebSocket = WebSocket as unknown as new (
	url: string,
	options: { headers: Record<string, string> },
) => WebSocket;
const base = `http://127.0.0.1:${server.port}`;
const post = (body: string, token = 't0k') =>
	fetch(`${base}/sync`, { method: 'POST', body, headers: { authorization: `Bearer ${token}` } });

describe('serve', () => {
	test('status codes for auth, routes, bad bodies and other protocols', async () => {
		expect((await post('{not json')).status).toBe(400);
		expect((await post(JSON.stringify({ protocol: 1, client: 'a', cursor: 0 }))).status).toBe(400);
		expect((await post(JSON.stringify({ protocol: 3, client: 'a', cursor: 0, writes: [] }))).status).toBe(426);
		expect((await post(JSON.stringify({ protocol: 1, client: 'a', cursor: 0, writes: [] }), 'nope')).status).toBe(401);
		expect((await fetch(`${base}/live`)).status).toBe(401);
		expect((await fetch(`${base}/live`, { headers: { authorization: 'Bearer t0k' } })).status).toBe(400);
		expect((await fetch(`${base}/sync`, { headers: { authorization: 'Bearer t0k' } })).status).toBe(404);
		expect((await fetch(`${base}/other`)).status).toBe(404);
	});

	test('a live socket answers ping and hears the new head after a write', async () => {
		const socket = new WebSocket(`${base.replace('http', 'ws')}/live`, [LIVE_PROTOCOL, 'bearer.t0k']);
		const messages: string[] = [];
		socket.addEventListener('message', event => messages.push(String(event.data)));
		await new Promise(resolve => socket.addEventListener('open', resolve));
		expect(socket.protocol).toBe(LIVE_PROTOCOL);

		socket.send('ping');
		await post(JSON.stringify({ protocol: 1, client: 'a', cursor: 0, writes: [] }));
		await post(
			JSON.stringify({
				protocol: 1,
				client: 'a',
				cursor: 0,
				writes: [{ seq: 1, table: 'notes', id: 'n1', op: 'put', values: { n: 1 } }],
			}),
		);
		while (messages.length < 2) await Bun.sleep(5);
		socket.close();
		expect(messages).toEqual(['pong', '{"head":1}']);
	});

	test('authorize sees one Authorization header for either token form', async () => {
		const strict = serve({
			driver: bunSqlite(':memory:'),
			schema,
			authorize: request => request.headers.get('authorization') === 'Bearer h3ad',
			port: 0,
		});
		const url = `http://127.0.0.1:${strict.port}`;
		try {
			const socket = new HeaderWebSocket(`${url.replace('http', 'ws')}/live`, {
				headers: { authorization: 'Bearer h3ad' },
			});
			const messages: string[] = [];
			socket.addEventListener('message', event => messages.push(String(event.data)));
			await new Promise(resolve => socket.addEventListener('open', resolve));

			const response = await fetch(`${url}/sync`, {
				method: 'POST',
				headers: { 'sec-websocket-protocol': `${LIVE_PROTOCOL}, bearer.h3ad` },
				body: JSON.stringify({
					protocol: 1,
					client: 'a',
					cursor: 0,
					writes: [{ seq: 1, table: 'notes', id: 'n1', op: 'put', values: { n: 1 } }],
				}),
			});
			expect(response.status).toBe(200);
			while (messages.length < 1) await Bun.sleep(5);
			socket.close();
			expect(messages).toEqual(['{"head":1}']);
			expect((await fetch(`${url}/live`, { headers: { upgrade: 'websocket' } })).status).toBe(401);
		} finally {
			strict.stop(true);
		}
	});
});
