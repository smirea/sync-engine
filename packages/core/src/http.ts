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

export const SyncRequestSchema = z.object({
	protocol: z.literal(1),
	client: z.string().min(1),
	cursor: z.int().nonnegative(),
	writes: z.array(WriteSchema),
});

export async function handleSync(space: Space, request: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'body is not JSON' }, { status: 400 });
	}
	if (typeof body === 'object' && body !== null && !Array.isArray(body) && Reflect.get(body, 'protocol') !== 1) {
		return Response.json({ error: 'protocol 1 required' }, { status: 426 });
	}
	const parsed = SyncRequestSchema.safeParse(body);
	if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
	const typed: SyncRequest = parsed.data;
	return Response.json(space.sync(typed));
}

export const LIVE_PROTOCOL = 'sync-engine.v1';

export function bearerToken(request: Request): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
	if (match) return match[1]!;
	const protocols = request.headers.get('sec-websocket-protocol')?.split(',') ?? [];
	const entry = protocols.map(p => p.trim()).find(p => p.startsWith('bearer.'));
	return entry ? entry.slice('bearer.'.length) : null;
}
