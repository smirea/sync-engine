import {
	createSpace,
	handleSync,
	LIVE_PROTOCOL,
	type Schema,
	type SqlDriver,
	withBearer,
} from '../../core/src/index.ts';
import { bunSqlite } from '../../bun-sqlite/src/index.ts';

export type ServeOptions = ({ driver: SqlDriver; file?: never } | { file: string; driver?: never }) & {
	schema: Schema;
	authorize(request: Request): boolean | Promise<boolean>;
	port?: number;
	hostname?: string;
};

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST',
	'access-control-allow-headers': 'authorization, content-type',
};

export function serve({ schema, authorize, port, hostname, ...storage }: ServeOptions) {
	const space = createSpace(storage.driver ?? bunSqlite(storage.file!), schema);
	space.migrate();
	return Bun.serve({
		port,
		hostname,
		async fetch(request, server) {
			const route = `${request.method} ${new URL(request.url).pathname}`;
			if (route === 'OPTIONS /sync') return new Response(null, { status: 204, headers: CORS });
			if (route !== 'POST /sync' && route !== 'GET /live') return new Response('not found', { status: 404 });
			// withBearer may rebuild the request, which moves the body, so /sync reads the normalized copy from here on.
			const normalized = withBearer(request);
			if (!(await authorize(normalized))) return new Response('unauthorized', { status: 401, headers: CORS });
			if (route === 'GET /live') {
				// Echo the subprotocol only when offered: a client that sent none, like the Swift one, fails on an echo.
				const offered = request.headers
					.get('sec-websocket-protocol')
					?.split(',')
					.some(p => p.trim() === LIVE_PROTOCOL);
				const headers = offered ? { 'Sec-WebSocket-Protocol': LIVE_PROTOCOL } : undefined;
				if (server.upgrade(request, { headers, data: undefined })) return undefined;
				return new Response('expected a WebSocket upgrade', { status: 400 });
			}
			const before = space.head();
			const response = await handleSync(space, normalized);
			const head = space.head();
			if (head > before) server.publish('live', JSON.stringify({ head }));
			for (const [header, value] of Object.entries(CORS)) response.headers.set(header, value);
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
