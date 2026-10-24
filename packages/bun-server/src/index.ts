import { createSpace, handleSync, LIVE_PROTOCOL, type Schema, type SqlDriver } from '@sync-engine/core';
// A relative import because adding @sync-engine/bun-sqlite to this package's dependencies changes bun.lock.
import { bunSqlite } from '../../bun-sqlite/src/index.ts';

export type ServeOptions = ({ driver: SqlDriver; file?: never } | { file: string; driver?: never }) & {
	schema: Schema;
	authorize(request: Request): boolean | Promise<boolean>;
	port?: number;
	hostname?: string;
};

export function serve({ schema, authorize, port, hostname, ...storage }: ServeOptions) {
	const space = createSpace(storage.driver ?? bunSqlite(storage.file!), schema);
	space.migrate();
	return Bun.serve({
		port,
		hostname,
		async fetch(request, server) {
			const route = `${request.method} ${new URL(request.url).pathname}`;
			if (route !== 'POST /sync' && route !== 'GET /live') return new Response('not found', { status: 404 });
			if (!(await authorize(request))) return new Response('unauthorized', { status: 401 });
			if (route === 'GET /live') {
				if (server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': LIVE_PROTOCOL }, data: undefined })) {
					return undefined;
				}
				return new Response('expected a WebSocket upgrade', { status: 400 });
			}
			const before = space.head();
			const response = await handleSync(space, request);
			const head = space.head();
			if (head > before) server.publish('live', JSON.stringify({ head }));
			return response;
		},
		websocket: {
			open: ws => void ws.subscribe('live'),
			message(ws, message) {
				if (message === 'ping') ws.send('pong');
			},
		},
	});
}
