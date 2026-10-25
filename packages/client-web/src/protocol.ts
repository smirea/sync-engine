import type { SqlValue, SyncResponse } from '../../core/src/index.ts';
import type { SyncStatus } from '../../client/src/index.ts';

export type Statement = { sql: string; params?: SqlValue[] };
export type QueryResult = { columns: string[]; rows: SqlValue[][] };
export type WebSyncStatus = SyncStatus & { clientId: string; host: boolean };
export type ErrorCode = 'already-open' | 'open-failed' | 'sql' | 'sync' | 'explicit-transaction' | 'closed';
export type Failure = { code: ErrorCode; message: string };

export class SyncWebError extends Error {
	constructor(
		public readonly code: ErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'SyncWebError';
	}
}

type Commands = {
	exec: { input: { sql: string; params: SqlValue[] }; output: QueryResult };
	batch: { input: { statements: Statement[] }; output: QueryResult[] };
	sync: { input: Record<never, never>; output: SyncResponse };
	status: { input: Record<never, never>; output: WebSyncStatus };
	setToken: { input: { token: string | null }; output: null };
	close: { input: Record<never, never>; output: null };
};
export type Kind = keyof Commands;
export type HostKind = 'exec' | 'batch' | 'sync' | 'status';
export type Input<K extends Kind> = Commands[K]['input'];
export type Output<K extends Kind> = Commands[K]['output'];
export type Call<K extends Kind = Kind> = K extends Kind ? { id: number; kind: K } & Input<K> : never;
export type Reply<K extends Kind = Kind> = K extends Kind
	? { id: number; kind: K; ok: true; result: Output<K> } | { id: number; kind: K; ok: false; error: Failure }
	: never;
export type Change = { kind: 'change'; tables: string[] };
export type ToTab = Reply | Change;
export type Bus =
	| { kind: 'call'; from: string; call: Call<HostKind> }
	| { kind: 'reply'; to: string; reply: Reply }
	| Change
	| { kind: 'host' }
	| { kind: 'hello' }
	| { kind: 'token'; token: string | null | undefined };
