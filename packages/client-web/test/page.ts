import { drizzleSyncDatabase, openSyncDatabase } from '../src/index.ts';
import { notes } from './schema.ts';

const db = openSyncDatabase({ worker: new Worker(`/worker.js${location.search}`, { type: 'module' }) });
const orm = drizzleSyncDatabase(db);
const changes: { tables: string[]; at: number }[] = [];
const now = () => performance.timeOrigin + performance.now();
db.onChange(tables => changes.push({ tables: [...tables], at: now() }));

Object.assign(window, {
	tab: {
		db,
		orm,
		changes,
		now,
		insert: (id: string, title: string) => orm.insert(notes).values({ id, title }),
		rows: () => orm.select().from(notes).orderBy(notes.id),
		status: () => db.status(),
	},
});
