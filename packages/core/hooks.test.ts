import { describe, expect, test } from 'bun:test';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bunSqlite } from '../bun-sqlite/src/index.ts';
import { createSpace, defineSchema, type PulledRow, type SpaceHooks, type Write } from './src/index.ts';

const notes = sqliteTable('notes', {
	id: text('id').primaryKey(),
	owner: text('owner').notNull(),
	title: text('title').notNull(),
	author: text('author'),
});
const grants = sqliteTable('grants', {
	id: text('id').primaryKey(),
	reader: text('reader').notNull(),
	note: text('note').notNull(),
});
const schema = defineSchema({ tables: { notes, grants } });

type Context = { user: string };

function setup(hooks: SpaceHooks<Context>) {
	const driver = bunSqlite(':memory:');
	const space = createSpace(driver, schema, { hooks });
	space.migrate();
	const sync = (user: string, writes: Write[], cursor = 0, client = `${user}-device`) =>
		space.sync({ protocol: 2, client, cursor, writes }, { user });
	return { driver, space, sync };
}

const put = (seq: number, id: string, values: Record<string, string | null>): Write => ({
	seq,
	table: 'notes',
	id,
	op: 'put',
	values,
});
const ids = (rows: readonly PulledRow[]) => rows.map(row => `${row.table}:${row.id}:${row.deleted}`);

describe('admit', () => {
	const ownOnly: SpaceHooks<Context> = {
		admit(write, { user }) {
			if (write.op === 'put' && write.values.owner !== user) return 'not yours';
			if (write.op === 'put' && write.values.title === 'skip') return null;
			return write.op === 'put' ? { ...write, values: { ...write.values, author: user } } : write;
		},
	};

	test('stamps, refuses, and skips with the request context', () => {
		const { driver, sync } = setup(ownOnly);
		const response = sync('ann', [
			put(1, 'a', { owner: 'ann', title: 'mine', author: 'forged' }),
			put(2, 'b', { owner: 'bob', title: 'theirs' }),
			put(3, 'c', { owner: 'ann', title: 'skip' }),
		]);
		expect(response.acked).toBe(3);
		expect(response.head).toBe(1);
		expect(response.rejected).toEqual([{ seq: 2, table: 'notes', id: 'b', reason: 'not yours' }]);
		expect(driver.exec('SELECT id, author FROM notes')).toEqual([{ id: 'a', author: 'ann' }]);
	});

	test('a refused write is not replayed by a retry', () => {
		const { sync } = setup(ownOnly);
		sync('ann', [put(1, 'b', { owner: 'bob', title: 'theirs' })]);
		expect(sync('ann', [put(1, 'b', { owner: 'bob', title: 'theirs' })]).rejected).toEqual([]);
	});
});

describe('landed', () => {
	test('derived writes count, sync, and see the applied values', () => {
		const seen: string[] = [];
		const { space, sync } = setup({
			landed(writes, _context, server) {
				for (const write of writes) {
					seen.push(`${write.op}:${write.id}`);
					if (write.op === 'put') server.put('grants', `g-${write.id}`, { reader: 'bob', note: write.id });
					if (write.op === 'delete') server.delete('grants', `g-${write.id}`);
				}
			},
		});
		sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
		expect(space.head()).toBe(2);
		expect(ids(sync('bob', [], 0).rows)).toEqual(['notes:a:0', 'grants:g-a:0']);
		sync('ann', [{ seq: 2, table: 'notes', id: 'a', op: 'delete' }]);
		expect(seen).toEqual(['put:a', 'delete:a']);
		expect(ids(sync('bob', [], 2).rows)).toEqual(['notes:a:1', 'grants:g-a:1']);
	});

	test('runs only when a write counted', () => {
		let calls = 0;
		const { sync } = setup({ landed: () => void calls++ });
		sync('ann', [{ seq: 1, table: 'notes', id: 'gone', op: 'patch', values: { title: 'x' } }]);
		expect(calls).toBe(0);
	});
});

describe('view', () => {
	const shared: SpaceHooks<Context> = {
		view({ user }) {
			return {
				sees(table, values) {
					if (table === 'grants') return values.reader === user;
					if (values.owner === user) return true;
					return grantedTo(user, String(values.id));
				},
				expand(rows) {
					return rows.flatMap(row => {
						if (row.table !== 'grants') return [];
						const [reader, note] = row.id.split(':');
						if (reader !== user) return [];
						const found = noteRow(note!);
						return row.deleted || !found ? [{ table: 'notes', id: note!, deleted: 1 as const }] : [found];
					});
				},
			};
		},
		admit(write, { user }) {
			if (write.table === 'notes' && write.op === 'put' && write.values.owner !== user) return 'not shared with you';
			return write;
		},
	};
	let grantedTo: (user: string, note: string) => boolean = () => false;
	let noteRow: (id: string) => PulledRow | undefined = () => undefined;

	function shareSetup() {
		const env = setup(shared);
		grantedTo = (user, note) =>
			env.driver.exec('SELECT 1 FROM grants WHERE reader = ? AND note = ?', [user, note]).length > 0;
		noteRow = id => {
			const row = env.driver.exec('SELECT id, owner, title, author FROM notes WHERE id = ?', [id])[0];
			return row && { table: 'notes', id, deleted: 0, values: row as Record<string, string | null> };
		};
		return env;
	}

	test('a snapshot holds only the rows the reader sees', () => {
		const { space, sync } = shareSetup();
		sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' }), put(2, 'b', { owner: 'ann', title: 'two' })]);
		space.write([{ table: 'grants', id: 'bob:b', op: 'put', values: { reader: 'bob', note: 'b' } }], { user: 'ann' });
		expect(ids(sync('bob', []).rows)).toEqual(['notes:b:0', 'grants:bob:b:0']);
		expect(ids(sync('cat', []).rows)).toEqual([]);
	});

	test('a grant made later opens an old row, and its removal closes it', () => {
		const { space, sync } = shareSetup();
		sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
		const cursor = sync('bob', []).head;
		space.write([{ table: 'grants', id: 'bob:a', op: 'put', values: { reader: 'bob', note: 'a' } }], { user: 'ann' });
		const opened = sync('bob', [], cursor);
		expect(ids(opened.rows)).toEqual(['grants:bob:a:0', 'notes:a:0']);
		space.write([{ table: 'grants', id: 'bob:a', op: 'delete' }], { user: 'ann' });
		expect(ids(sync('bob', [], opened.head).rows)).toEqual(['grants:bob:a:1', 'notes:a:1']);
	});

	test('a refused write the reader cannot see comes back as a tombstone', () => {
		const { sync } = shareSetup();
		sync('ann', [put(1, 'a', { owner: 'ann', title: 'one' })]);
		const response = sync('bob', [put(1, 'a', { owner: 'ann', title: 'stolen' })]);
		expect(response.rejected.map(r => r.reason)).toEqual(['not shared with you']);
		expect(ids(response.rows)).toEqual(['notes:a:1']);
	});
});

describe('write', () => {
	const hooks: SpaceHooks<Context> = {
		admit: (write, { user }) => (write.op === 'put' && write.values.owner !== user ? 'not yours' : write),
	};

	test('applies through the hooks as the server client', () => {
		const { driver, space } = setup(hooks);
		const result = space.write([{ table: 'notes', id: 'a', op: 'put', values: { owner: 'ann', title: 'one' } }], {
			user: 'ann',
		});
		expect(result).toEqual({ rejected: [], head: 1 });
		expect(driver.exec('SELECT client FROM _log')).toEqual([{ client: 'server' }]);
	});

	test('atomic rolls back every write when one is refused', () => {
		const { driver, space } = setup(hooks);
		const result = space.write(
			[
				{ table: 'notes', id: 'a', op: 'put', values: { owner: 'ann', title: 'one' } },
				{ table: 'notes', id: 'b', op: 'put', values: { owner: 'bob', title: 'two' } },
			],
			{ user: 'ann' },
			{ atomic: true },
		);
		expect(result).toEqual({ rejected: [{ seq: 0, table: 'notes', id: 'b', reason: 'not yours' }], head: 0 });
		expect(driver.exec('SELECT id FROM notes')).toEqual([]);
	});
});

describe('change', () => {
	test('server rows written outside a sync count and reach readers', () => {
		const { space, sync } = setup({});
		const head = space.change(server => {
			server.put('notes', 'a', { owner: 'ann', title: 'derived' });
			return space.head();
		});
		expect(head).toBe(1);
		expect(ids(sync('bob', []).rows)).toEqual(['notes:a:0']);
		expect(() => space.change(server => server.put('notes', 'b', { owner: 'ann' }))).toThrow(
			'notes b: title: required',
		);
	});
});
