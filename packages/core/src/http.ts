import { z } from 'zod';
import type { Space } from './space.ts';
import type { SyncRequest } from './types.ts';

const ValueSchema = z.union([z.string(), z.number(), z.null()]);
const ValuesSchema = z.record(z.string(), ValueSchema);
const target = { seq: z.int(), table: z.string(), id: z.string() };
const WriteSchema = z.discriminatedUnion('op', [
	z.object({ ...target, op: z.literal('put'), values: ValuesSchema }),
	z.object({ ...target, op: z.literal('patch'), values: ValuesSchema }),
	z.object({ ...target, op: z.literal('delete') }),
]);

const body = { client: z.string().min(1), cursor: z.int().nonnegative(), writes: z.array(WriteSchema) };
export const SyncRequestSchema = z.discriminatedUnion('protocol', [
	z.object({ protocol: z.literal(1), ...body }),
	z.object({ protocol: z.literal(2), ...body, after: z.object({ table: z.string(), id: z.string() }).optional() }),
]);

/** `context` reaches the space's hooks; an app without hooks passes nothing. */
export async function handleSync<C = void>(
	space: Space<C>,
	request: Request,
	...context: C extends void ? [] : [C]
): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'body is not JSON' }, { status: 400 });
	}
	if (
		typeof body === 'object' &&
		body !== null &&
		!Array.isArray(body) &&
		![1, 2].includes(Reflect.get(body, 'protocol'))
	) {
		return Response.json({ error: 'protocol 1 or 2 required' }, { status: 426 });
	}
	const parsed = SyncRequestSchema.safeParse(body);
	if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
	const typed: SyncRequest = parsed.data;
	return Response.json(space.sync(typed, context[0] as C));
}

export const LIVE_PROTOCOL = 'sync-engine.v1';

export function bearerToken(request: Request): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
	if (match) return match[1]!;
	const protocols = request.headers.get('sec-websocket-protocol')?.split(',') ?? [];
	const entry = protocols.map(p => p.trim()).find(p => p.startsWith('bearer.'));
	return entry ? entry.slice('bearer.'.length) : null;
}

/**
 * What the app's `authorize` sees. The Swift client sends the bearer on the `/live` upgrade as a header and a browser
 * can only send it as a subprotocol, so the subprotocol form is copied into `Authorization` and an owner check reads
 * one place. Servers still upgrade the original request.
 */
export function withBearer(request: Request): Request {
	if (request.headers.has('authorization')) return request;
	const token = bearerToken(request);
	if (!token) return request;
	const headers = new Headers(request.headers);
	headers.set('authorization', `Bearer ${token}`);
	return new Request(request, { headers });
}
