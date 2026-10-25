import {
	createClient,
	LIVE_PROTOCOL,
	type Schema,
	type SqlDriver,
	type SyncRequest,
	type SyncResponse,
	type Write,
} from '../../core/src/index.ts';

export type SyncClientOptions = {
	driver: SqlDriver;
	schema: Schema;
	/** The server's base URL, such as `http://127.0.0.1:1234`. */
	endpoint: string;
	token?: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
	/** Milliseconds between periodic syncs while started. */
	interval?: number;
	/** Longest wait in milliseconds before a failed sync is retried or a dropped socket is reopened. */
	maxBackoff?: number;
};

export type SyncStatus = {
	live: boolean;
	syncing: boolean;
	pending: number;
	cursor: number;
	lastError: string | null;
	/** A paged snapshot in progress and the rows this run has applied so far, else null. */
	snapshot: { rows: number } | null;
};

export type SyncClient = {
	migrate(): void;
	sync(): Promise<SyncResponse>;
	start(): void;
	stop(): void;
	markDirty(): void;
	status(): SyncStatus;
	onChange(listener: (tables: ReadonlySet<string>) => void): () => void;
	clientId(): string;
};

type Run =
	| { kind: 'idle' }
	| { kind: 'running'; done: Promise<void> }
	| { kind: 'queued'; done: Promise<void>; next: Promise<SyncResponse> };

type Live = {
	socket: WebSocket | null;
	heard: boolean;
	backoff: number;
	timers: ReturnType<typeof setTimeout>[];
	reconnect: ReturnType<typeof setTimeout> | null;
};

const PING_MS = 30_000;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15_000;
const DIRTY_MS = 100;

export function createSyncClient(options: SyncClientOptions): SyncClient {
	const core = createClient(options.driver, options.schema);
	const fetchFn = options.fetch ?? globalThis.fetch;
	const Socket = options.WebSocket ?? globalThis.WebSocket;
	const maxBackoff = options.maxBackoff ?? MAX_BACKOFF_MS;
	const firstBackoff = Math.min(FIRST_BACKOFF_MS, maxBackoff);
	const listeners = new Set<(tables: ReadonlySet<string>) => void>();
	let migrated = false;
	let run: Run = { kind: 'idle' };
	let lastError: string | null = null;
	let dirty: ReturnType<typeof setTimeout> | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let retryBackoff = firstBackoff;
	let live: Live | null = null;
	let snapshotRows = 0;

	const ready = () => {
		if (!migrated) throw new Error('call migrate() before using the sync client');
	};
	const background = () => void sync().catch(() => {});

	async function post(writes: Write[]): Promise<SyncResponse> {
		const progress = core.snapshot();
		const request: SyncRequest = {
			protocol: 2,
			client: core.clientId(),
			cursor: core.cursor(),
			writes,
			...(progress ? { after: progress.after } : {}),
		};
		const reply = await fetchFn(`${options.endpoint}/sync`, {
			method: 'POST',
			headers: {
				...options.headers,
				'content-type': 'application/json',
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			},
			body: JSON.stringify(request),
		});
		if (!reply.ok) throw new Error(`sync failed with ${reply.status}: ${await reply.text()}`);
		return (await reply.json()) as SyncResponse;
	}

	/** One sync: the outbox goes with the first request, then every remaining snapshot page with no writes. */
	async function once(): Promise<{ response: SyncResponse; touched: Set<string> }> {
		try {
			const touched = new Set<string>();
			let batch = core.collect();
			let response: SyncResponse;
			do {
				response = await post(batch.writes);
				for (const table of core.apply(response, batch.acked)) touched.add(table);
				batch = { writes: [], acked: 0 };
				snapshotRows = core.snapshot() ? snapshotRows + response.rows.length : 0;
			} while (core.snapshot());
			lastError = null;
			return { response, touched };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	async function begin(): Promise<SyncResponse> {
		const done = Promise.withResolvers<void>();
		run = { kind: 'running', done: done.promise };
		const settle = () => {
			if (run.kind === 'running' && run.done === done.promise) run = { kind: 'idle' };
			done.resolve();
		};
		try {
			const { response, touched } = await once();
			retryBackoff = firstBackoff;
			// Settle before notifying so a listener reads the status of a finished sync.
			settle();
			if (touched.size) for (const listener of listeners) listener(touched);
			return response;
		} catch (error) {
			if (live && !retry) {
				retry = setTimeout(() => {
					retry = null;
					background();
				}, retryBackoff);
				retryBackoff = Math.min(retryBackoff * 2, maxBackoff);
			}
			throw error;
		} finally {
			settle();
		}
	}

	function clearRetry() {
		if (retry) clearTimeout(retry);
		retry = null;
	}

	function sync(): Promise<SyncResponse> {
		ready();
		switch (run.kind) {
			case 'idle':
				return begin();
			case 'running': {
				const next = run.done.then(begin);
				run = { kind: 'queued', done: run.done, next };
				return next;
			}
			case 'queued':
				return run.next;
		}
	}

	function connect(state: Live) {
		const url = `${options.endpoint.replace(/^http/, 'ws')}/live`;
		const socket = new Socket(url, options.token ? [LIVE_PROTOCOL, `bearer.${options.token}`] : [LIVE_PROTOCOL]);
		state.socket = socket;
		socket.addEventListener('open', () => {
			state.heard = true;
			state.backoff = firstBackoff;
			background();
		});
		socket.addEventListener('message', event => {
			state.heard = true;
			if (event.data === 'pong') return;
			let head: unknown;
			try {
				head = (JSON.parse(String(event.data)) as { head?: unknown }).head;
			} catch {
				return;
			}
			if (typeof head === 'number' && head > core.cursor()) background();
		});
		socket.addEventListener('close', () => {
			if (state.socket === socket) drop(state);
		});
	}

	function drop(state: Live) {
		state.socket?.close();
		state.socket = null;
		if (live !== state) return;
		state.reconnect = setTimeout(() => {
			state.reconnect = null;
			connect(state);
		}, state.backoff);
		state.backoff = Math.min(state.backoff * 2, maxBackoff);
	}

	function wake() {
		retryBackoff = firstBackoff;
		clearRetry();
		const state = live;
		if (state) {
			state.backoff = firstBackoff;
			if (state.reconnect) {
				clearTimeout(state.reconnect);
				state.reconnect = null;
				connect(state);
			}
		}
		background();
	}

	const visible = () => {
		if (globalThis.document?.visibilityState !== 'hidden') wake();
	};

	function ping(state: Live) {
		if (state.socket?.readyState !== Socket.OPEN) return;
		// No message since the last ping: the connection is dead even if the socket never reported a close.
		if (!state.heard) return drop(state);
		state.heard = false;
		state.socket.send('ping');
	}

	return {
		migrate() {
			core.migrate();
			migrated = true;
		},
		sync,
		start() {
			ready();
			if (live) return;
			const state: Live = {
				socket: null,
				heard: true,
				backoff: firstBackoff,
				timers: [],
				reconnect: null,
			};
			live = state;
			state.timers.push(
				setInterval(() => ping(state), PING_MS),
				setInterval(background, options.interval ?? 60_000),
			);
			globalThis.addEventListener?.('online', wake);
			globalThis.document?.addEventListener('visibilitychange', visible);
			connect(state);
		},
		stop() {
			const state = live;
			if (!state) return;
			live = null;
			clearRetry();
			for (const timer of state.timers) clearInterval(timer);
			if (state.reconnect) clearTimeout(state.reconnect);
			globalThis.removeEventListener?.('online', wake);
			globalThis.document?.removeEventListener('visibilitychange', visible);
			drop(state);
		},
		markDirty() {
			ready();
			clearRetry();
			if (dirty) return;
			dirty = setTimeout(() => {
				dirty = null;
				background();
			}, DIRTY_MS);
		},
		status() {
			ready();
			return {
				live: live?.socket?.readyState === Socket.OPEN,
				syncing: run.kind !== 'idle',
				pending: core.pending(),
				cursor: core.cursor(),
				lastError,
				snapshot: core.snapshot() ? { rows: snapshotRows } : null,
			};
		},
		onChange(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		clientId() {
			ready();
			return core.clientId();
		},
	};
}
