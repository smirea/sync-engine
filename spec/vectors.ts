/** The shape of `spec/vectors.json`, shared by `scripts/spec-vectors.ts` (writer) and `packages/core/spec.test.ts` (reader). */

/** A model row: only the columns the model set. The SQL side reads a missing column as null. */
export type SparseRow = Record<string, number>;
export type Rows = Record<string, Record<string, SparseRow>>;

export type ModelState = {
	head: number;
	rows: Rows;
	/** Stamp per (table, id). A stamped key with no row in `rows` is a tombstone. */
	changes: Record<string, Record<string, number>>;
	clients: Record<string, number>;
};

export type VectorWrite = { client: string; seq: number; table: string; id: string; state: ModelState } & (
	| { op: 'put'; values: SparseRow }
	| { op: 'patch'; values: SparseRow }
	| { op: 'delete' }
);

export type PulledVector =
	| { table: string; id: string; deleted: 0; values: SparseRow }
	| { table: string; id: string; deleted: 1 };
export type PullVector = { cursor: number; head: number; rows: PulledVector[] };

export type Scenario = {
	name: string;
	writes: VectorWrite[];
	pulls: PullVector[];
	applyPull: { local: Rows; cursor: number; pull: PullVector; result: { local: Rows; cursor: number } };
};

export type Vectors = { bend_sha256: string; scenarios: Scenario[] };
