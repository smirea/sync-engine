import { drizzleSyncDatabase, openSyncDatabase } from "../src/index.ts";
import { notes } from "./schema.ts";

const db = openSyncDatabase({
  worker: new Worker(`/worker.js${location.search}`, { type: "module" }),
});
const orm = drizzleSyncDatabase(db);
const changes: { tables: string[] }[] = [];
db.onChange((tables) => changes.push({ tables: [...tables] }));
const statuses: Awaited<ReturnType<typeof db.status>>[] = [];
db.onStatus((status) => statuses.push({ ...status, clientId: "", host: false }));

Object.assign(window, {
  tab: {
    db,
    orm,
    changes,
    statuses,
    insert: (id: string, title: string) => orm.insert(notes).values({ id, title }),
    rows: () => orm.select().from(notes).orderBy(notes.id),
    status: () => db.status(),
  },
});
