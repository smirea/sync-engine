import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export type SyncOptions = {
	namespace: DurableObjectNamespace;
	spaceId: string;
	authorize(request: Request): boolean | Promise<boolean>;
};

export async function handleSync(request: Request, { namespace, spaceId, authorize }: SyncOptions): Promise<Response> {
	if (!(await authorize(request))) return new Response('unauthorized', { status: 401 });
	// The stub speaks the Workers Request and Response types, which this tsconfig's Bun globals do not know.
	const stub = namespace.get(namespace.idFromName(spaceId)) as unknown as { fetch: typeof fetch };
	return stub.fetch(request);
}
