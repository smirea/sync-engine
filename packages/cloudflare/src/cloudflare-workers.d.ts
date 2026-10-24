// The runtime provides these; @cloudflare/workers-types declares them only when it is a global `types` entry, and
// making it one would shadow Bun's globals for the whole workspace.
declare module 'cloudflare:workers' {
	export abstract class DurableObject<Env = unknown> {
		protected ctx: import('@cloudflare/workers-types').DurableObjectState;
		protected env: Env;
		constructor(ctx: import('@cloudflare/workers-types').DurableObjectState, env: Env);
		fetch?(request: Request): Response | Promise<Response>;
	}
}

declare const WebSocketPair: typeof import('@cloudflare/workers-types').WebSocketPair;
declare const WebSocketRequestResponsePair: typeof import('@cloudflare/workers-types').WebSocketRequestResponsePair;
