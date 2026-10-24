import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import { bearerToken } from '@sync-engine/core';
import { handleSync, SpaceObject } from '@sync-engine/cloudflare';
import { schema } from './schema.ts';

type Env = { SPACE: DurableObjectNamespace };

export class Space extends SpaceObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, schema);
	}
}

export default {
	fetch: (request: Request, env: Env) =>
		handleSync(request, { namespace: env.SPACE, spaceId: 'demo', authorize: r => bearerToken(r) === 'dev' }),
};
