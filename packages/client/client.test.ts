import { afterEach, describe, expect, jest, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bunSqlite } from "../bun-sqlite/src/index.ts";
import {
  bearerToken,
  createSpace,
  defineSchema,
  handleSync,
  type SqlDriver,
  type SyncRequest,
  type SyncResponse,
} from "../core/src/index.ts";
import {
  createSyncClient,
  type SyncClient,
  type SyncClientOptions,
  type SyncStatus,
} from "./src/index.ts";

const schema = defineSchema({
  tables: {
    notes: sqliteTable("notes", {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
      done: integer("done").notNull().default(0),
    }),
    tags: sqliteTable("tags", { id: text("id").primaryKey(), label: text("label").notNull() }),
  },
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).toReversed()) fn();
  jest.useRealTimers();
});

/** A space answered in-process: `fetch` hands each request to `handleSync`, so no port or network is involved. */
function server(options: { pageSize?: number; authorize?: (request: Request) => boolean } = {}) {
  const space = createSpace(bunSqlite(":memory:"), schema, { pageSize: options.pageSize });
  space.migrate();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (options.authorize && !options.authorize(request))
      return new Response("unauthorized", { status: 401 });
    return handleSync(space, request);
  }) as typeof globalThis.fetch;
  return { space, fetch };
}

/** WebSockets that open, deliver and close only when a test says so. */
function sockets() {
  const created: Stub[] = [];
  class Stub extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      created.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    message(data: string) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  return { Socket: Stub as unknown as typeof WebSocket, created };
}

function peer(fetch: typeof globalThis.fetch, extra: Partial<SyncClientOptions> = {}) {
  const db = bunSqlite(":memory:");
  const client = createSyncClient({
    driver: db,
    schema,
    endpoint: "http://sync.test",
    fetch,
    WebSocket: sockets().Socket,
    ...extra,
  });
  client.migrate();
  cleanup.push(() => client.stop());
  return {
    db,
    client,
    rows: () => db.exec("SELECT * FROM notes ORDER BY id"),
    nextChange: () =>
      new Promise<ReadonlySet<string>>((resolve) => {
        const off = client.onChange((tables) => {
          off();
          resolve(tables);
        });
      }),
  };
}

const settled = (client: SyncClient) =>
  new Promise<SyncStatus>((resolve) => {
    const off = client.onStatus((status) => {
      off();
      resolve(status);
    });
  });

const insert = (db: SqlDriver, id: string, title: string) =>
  db.exec("INSERT INTO notes (id, title) VALUES (?, ?)", [id, title]);

describe("createSyncClient", () => {
  test("a server older than spaces keeps a client in deltas after its first snapshot", async () => {
    const { fetch } = server();
    const responses: SyncResponse[] = [];
    // A server from before spaces drops the request's `space` as an unknown key and never sends one.
    const older = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { space: _sent, ...request } = JSON.parse(String(init!.body));
      const reply = await fetch(input, { ...init, body: JSON.stringify(request) });
      const { space: _answered, ...response } = (await reply.json()) as SyncResponse;
      responses.push(response);
      return Response.json(response, { status: reply.status });
    }) as typeof fetch;
    const a = peer(older);
    const b = peer(older);

    insert(a.db, "n1", "one");
    await a.client.sync();
    await b.client.sync();
    insert(b.db, "n2", "two");
    await b.client.sync();
    a.db.exec("UPDATE notes SET title = 'edited' WHERE id = 'n1'");
    await a.client.sync();
    await b.client.sync();
    await b.client.sync();

    expect(responses.map((response) => response.snapshot)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(b.rows().map((row) => [row.id, row.title])).toEqual([
      ["n1", "edited"],
      ["n2", "two"],
    ]);
    expect(b.client.status().cursor).toBe(3);
  });

  test("a paged snapshot runs in one sync and reports the rows applied so far", async () => {
    const { fetch } = server({ pageSize: 2 });
    const a = peer(fetch);
    for (let i = 1; i <= 5; i++) insert(a.db, `n${i}`, `note ${i}`);
    await a.client.sync();

    const seen: (SyncStatus["snapshot"] | "done")[] = [];
    const pages: (SyncRequest & { protocol: 2 })[] = [];
    const watching = (async (input: RequestInfo | URL, init?: RequestInit) => {
      pages.push(JSON.parse(String(init?.body)) as SyncRequest & { protocol: 2 });
      const response = await fetch(input, init);
      seen.push(c.client.status().snapshot ?? "done");
      return response;
    }) as typeof fetch;
    const c = peer(watching);
    const changed = c.nextChange();
    const last = await c.client.sync();
    expect(pages.map((page) => [page.cursor, page.after?.id ?? null, page.writes.length])).toEqual([
      [0, null, 0],
      [0, "n2", 0],
      [0, "n4", 0],
    ]);
    expect(seen).toEqual(["done", { rows: 2 }, { rows: 4 }]);
    expect({ snapshot: last.snapshot, next: last.next, head: last.head }).toEqual({
      snapshot: true,
      next: null,
      head: 5,
    });
    expect(await changed).toEqual(new Set(["notes"]));
    expect(c.rows().map((r) => r.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(c.client.status()).toMatchObject({
      syncing: false,
      pending: 0,
      cursor: 5,
      snapshot: null,
    });
  });

  test("a page that fails after a committed page still reports the committed tables", async () => {
    const { fetch } = server({ pageSize: 2 });
    const a = peer(fetch);
    insert(a.db, "n1", "one");
    insert(a.db, "n2", "two");
    a.db.exec("INSERT INTO tags (id, label) VALUES ('t1', 'red'), ('t2', 'blue')");
    await a.client.sync();

    let calls = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 2) throw new Error("page 2 lost");
      return fetch(input, init);
    }) as typeof fetch;
    const c = peer(flaky);
    await expect(c.client.sync()).rejects.toThrow("page 2 lost");
    expect(c.rows().map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(c.client.status().snapshot).toEqual({ rows: 2 });

    const changed = c.nextChange();
    await c.client.sync();
    expect(await changed).toEqual(new Set(["notes", "tags"]));
    expect(c.db.exec("SELECT id FROM tags ORDER BY id")).toEqual([{ id: "t1" }, { id: "t2" }]);
    expect(c.client.status().snapshot).toBeNull();
  });

  test("overlapping syncs run one after another, and the calls queued behind a run share one sync", async () => {
    const { fetch } = server();
    const calls: { start: number; end: number }[] = [];
    let clock = 0;
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { start: ++clock, end: 0 };
      calls.push(call);
      const response = await fetch(input, init);
      call.end = ++clock;
      return response;
    }) as typeof fetch;
    const a = peer(recording);

    insert(a.db, "n1", "first");
    const resolved: string[] = [];
    const first = a.client.sync().then((response) => (resolved.push("first"), response));
    insert(a.db, "n2", "second");
    const second = a.client.sync().then((response) => (resolved.push("second"), response));
    const third = a.client.sync().then((response) => (resolved.push("third"), response));
    expect(a.client.status().syncing).toBe(true);

    expect((await first).rows.map((r) => r.id)).toEqual(["n1"]);
    expect((await second).rows.map((r) => r.id)).toEqual(["n2"]);
    expect(await third).toBe(await second);
    expect(resolved).toEqual(["first", "second", "third"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.end).toBeLessThan(calls[1]!.start);
    expect(a.client.status().syncing).toBe(false);
  });

  test("a 401 rejects the sync, keeps the outbox and marks the client unauthorized", async () => {
    const { fetch } = server({ authorize: (request) => bearerToken(request) === "secret" });
    const wrong = peer(fetch, { token: "wrong" });
    insert(wrong.db, "n1", "kept");
    await expect(wrong.client.sync()).rejects.toThrow("401");
    expect(wrong.client.status()).toMatchObject({ pending: 1, cursor: 0, unauthorized: true });

    const right = peer(fetch, { token: "secret" });
    insert(right.db, "n2", "sent");
    expect((await right.client.sync()).acked).toBe(1);
    expect(right.client.status()).toMatchObject({ pending: 0, unauthorized: false });
  });

  test("after a 401 nothing syncs on its own until start or sync", async () => {
    jest.useFakeTimers();
    let requests = 0;
    const refused = peer(
      (async () => {
        requests++;
        return new Response("unauthorized", { status: 401 });
      }) as unknown as typeof fetch,
      { token: "expired", maxBackoff: 20 },
    );
    let status = settled(refused.client);
    refused.client.start();
    jest.advanceTimersByTime(20);
    expect((await status).unauthorized).toBe(true);
    expect(requests).toBe(1);

    insert(refused.db, "n1", "waits");
    refused.client.markDirty();
    jest.advanceTimersByTime(60_000);
    expect(requests).toBe(1);

    await expect(refused.client.sync()).rejects.toThrow("401");
    expect(requests).toBe(2);
    status = settled(refused.client);
    refused.client.start();
    await status;
    expect(requests).toBe(3);
  });

  test("keeps the last writes the server refused, newest first", async () => {
    const reply = (rejected: SyncResponse["rejected"]): SyncResponse => ({
      head: 0,
      acked: 2,
      rejected,
      snapshot: false,
      rows: [],
      next: null,
    });
    const answers = [
      reply([{ seq: 1, table: "notes", id: "a", reason: "first" }]),
      reply([{ seq: 2, table: "notes", id: "b", reason: "second" }]),
    ];
    const client = peer((async () => Response.json(answers.shift())) as unknown as typeof fetch);
    await client.client.sync();
    await client.client.sync();
    expect(client.client.status().rejected.map((r) => r.reason)).toEqual(["second", "first"]);
  });

  test("a head above the cursor on the live socket makes a started client pull", async () => {
    const { fetch } = server();
    const live = sockets();
    const a = peer(fetch);
    const b = peer(fetch, { WebSocket: live.Socket });
    b.client.start();
    const opened = settled(b.client);
    live.created[0]!.open();
    await opened;

    insert(a.db, "n1", "live");
    await a.client.sync();
    const changed = b.nextChange();
    live.created[0]!.message(JSON.stringify({ head: 1 }));
    expect(await changed).toEqual(new Set(["notes"]));
    expect(b.rows()).toEqual([{ id: "n1", title: "live", done: 0 }]);
  });

  test("a started client whose socket never opens still pulls on every maxBackoff tick", async () => {
    const { fetch } = server();
    const a = peer(fetch);
    insert(a.db, "n1", "while dead");
    await a.client.sync();

    jest.useFakeTimers();
    const b = peer(fetch, { maxBackoff: 250 });
    b.client.start();
    const changed = b.nextChange();
    jest.advanceTimersByTime(250);
    expect(await changed).toEqual(new Set(["notes"]));
    expect(b.rows()).toEqual([{ id: "n1", title: "while dead", done: 0 }]);
    expect(b.client.status().live).toBe(false);
  });

  test("beforePush runs before a sync that sends writes, and its throw keeps the writes for the retry", async () => {
    const { fetch, space } = server();
    let fail = true;
    let calls = 0;
    const a = peer(fetch, {
      beforePush: async () => {
        calls++;
        if (fail) throw new Error("upload the files first");
      },
    });
    await a.client.sync();
    expect(calls).toBe(0);
    insert(a.db, "n1", "needs a file");
    await expect(a.client.sync()).rejects.toThrow("upload the files first");
    expect(a.client.status().pending).toBe(1);
    fail = false;
    await a.client.sync();
    expect(calls).toBe(2);
    expect(space.dump().notes!.map((row) => row.id)).toEqual(["n1"]);
  });

  test("reset refuses while the loop runs, and clears the status it leaves", async () => {
    const { fetch } = server();
    const a = peer(fetch);
    insert(a.db, "n1", "one");
    await a.client.sync();
    a.client.start();
    await expect(a.client.reset()).rejects.toThrow();
    a.client.stop();
    await a.client.reset();
    expect(a.rows()).toEqual([]);
    expect(a.client.status()).toMatchObject({
      pending: 0,
      cursor: 0,
      lastError: null,
      unauthorized: false,
      rejected: [],
    });
  });
});
