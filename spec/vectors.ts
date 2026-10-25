/** The shape of `spec/vectors.json`, shared by `scripts/spec-vectors.ts` (writer) and `packages/core/spec.test.ts` (reader). */

/** A model row: only the columns the model set. The SQL side reads a missing column as null. */
export type SparseRow = Record<string, number>;
export type Rows = Record<string, Record<string, SparseRow>>;
export type Key = { table: string; id: string };

export type ModelState = {
	head: number;
	rows: Rows;
	/** Stamp per (table, id). A stamped key with no row in `rows` is a tombstone. */
	changes: Record<string, Record<string, number>>;
	clients: Record<string, number>;
	horizon: number;
};

export type WriteVector = { seq: number; table: string; id: string } & (
	| { op: 'put'; values: SparseRow }
	| { op: 'patch'; values: SparseRow }
	| { op: 'delete' }
);
export type VectorWrite = WriteVector & { client: string; state: ModelState };

export type PulledVector =
	| { table: string; id: string; deleted: 0; values: SparseRow }
	| { table: string; id: string; deleted: 1 };
export type PullVector = { cursor: number; head: number; snapshot: boolean; rows: PulledVector[] };

/** A local change on the client, in the order the app made them; each fires one outbox trigger. */
export type LocalOp =
	| { op: 'insert'; table: string; id: string; values: SparseRow }
	| { op: 'update'; table: string; id: string; col: string; value: number }
	| { op: 'delete'; table: string; id: string };

export type PageVector = {
	/** How many scenario writes the server had applied when this page was taken. */
	at: number;
	after: Key | null;
	head: number;
	rows: PulledVector[];
	next: Key | null;
};

export type Scenario = {
	name: string;
	writes: VectorWrite[];
	pulls: PullVector[];
	applyPull: { local: Rows; cursor: number; pull: PullVector; result: { local: Rows; cursor: number } };
	/** Compaction once the first `at` writes are older than the retention: the horizon it reaches and pulls around it. */
	compaction: { at: number; horizon: number; state: ModelState; pulls: PullVector[] };
	/** An outbox built by `ops` on top of `local`, coalesced by `collect` and applied as one batch in that order. */
	batch: { client: string; local: Rows; ops: LocalOp[]; writes: WriteVector[]; state: ModelState };
	/** Pages of `size` rows taken while the writes after `from` land, then a delta from the first page's head. */
	paging: { from: number; size: number; pages: PageVector[]; cursor: number; final: { local: Rows; cursor: number } };
};

export type Vectors = { bend_sha256: string; scenarios: Scenario[] };
