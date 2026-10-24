/// <reference path="./cloudflare-workers.d.ts" />
import type { DurableObjectState } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import {
	createSpace,
	handleSync as syncOverHttp,
	LIVE_PROTOCOL,
	type Schema,
	type Space,
} from '../../core/src/index.ts';
import { durableDriver } from './driver.ts';

export class SpaceObject<Env = unknown> extends DurableObject<Env> {
	protected readonly space: Space;

	constructor(ctx: DurableObjectState, env: Env, schema: Schema) {
		super(ctx, env);
		this.space = createSpace(durableDriver(ctx.storage), schema);
		ctx.blockConcurrencyWhile(async () => this.space.migrate());
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	override async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === 'POST' && pathname === '/sync') {
			const before = this.space.head();
			const response = await syncOverHttp(this.space, request);
			const head = this.space.head();
			if (head > before) this.broadcast(JSON.stringify({ head }));
			return response;
		}
		if (request.method === 'GET' && pathname === '/live') {
			if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('expected a WebSocket', { status: 426 });
			}
			const { 0: client, 1: server } = new WebSocketPair();
			this.ctx.acceptWebSocket(server);
			const offered = request.headers
				.get('sec-websocket-protocol')
				?.split(',')
				.some(p => p.trim() === LIVE_PROTOCOL);
			return new Response(null, {
				status: 101,
				webSocket: client,
				headers: offered ? { 'Sec-WebSocket-Protocol': LIVE_PROTOCOL } : {},
			} as ResponseInit);
		}
		return new Response('not found', { status: 404 });
	}

	private broadcast(message: string) {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch {
				// a socket mid-close throws on send, and it has no one left to nudge
			}
		}
	}
}
