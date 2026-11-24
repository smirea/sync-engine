import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { blob, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { defineSchema } from "./src/index.ts";

const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default("it's"),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  tags: text("tags", { mode: "json" }).notNull().default([]),
  weight: real("weight"),
  at: integer("at", { mode: "timestamp" }),
});

describe("defineSchema", () => {
  test("a drizzle table becomes its columns, defaults, JSON flags and CREATE TABLE", () => {
    const schema = defineSchema({
      tables: { notes },
      values: { notes: { tags: z.array(z.string()) } },
    });
    expect(
      schema.tables.map((t) => ({
        ...t,
        columns: t.columns.map(({ validate: _validate, ...c }) => c),
      })),
    ).toEqual([
      {
        name: "notes",
        columns: [
          { name: "id", type: "TEXT", notNull: true, json: false },
          { name: "title", type: "TEXT", notNull: true, json: false },
          { name: "body", type: "TEXT", notNull: true, json: false, default: "it's" },
          { name: "done", type: "INTEGER", notNull: true, json: false, default: 0 },
          { name: "tags", type: "TEXT", notNull: true, json: true, default: "[]" },
          { name: "weight", type: "REAL", notNull: false, json: false },
          { name: "at", type: "INTEGER", notNull: false, json: false },
        ],
      },
    ]);
    expect(schema.tables[0]!.columns[4]!.validate?.safeParse(["a"]).success).toBe(true);
    expect(schema.ddl.app).toEqual([
      "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT 'it''s', done INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', weight REAL, at INTEGER)",
    ]);
  });

  test("a schema the protocol cannot carry is refused", () => {
    const id = text("id").primaryKey();
    expect(() =>
      defineSchema({ tables: { a: sqliteTable("a", { id, data: blob("data") }) } }),
    ).toThrow();
    expect(() =>
      defineSchema({ tables: { a: sqliteTable("a", { id: integer("id").primaryKey() }) } }),
    ).toThrow();
    expect(() =>
      defineSchema({ tables: { a: sqliteTable("a", { id, camelCase: text("camelCase") }) } }),
    ).toThrow();
    expect(() => defineSchema({ tables: { a: sqliteTable("Bad-Name", { id }) } })).toThrow();
    expect(() =>
      defineSchema({ tables: { a: sqliteTable("a", { id, order: real("order") }) } }),
    ).toThrow();
    expect(() => defineSchema({ tables: { a: sqliteTable("group", { id }) } })).toThrow();
    expect(() =>
      defineSchema({
        tables: { a: sqliteTable("a", { id, at: integer("at").default(sql`(unixepoch())`) }) },
      }),
    ).toThrow();
    const a = sqliteTable("a", { id, x: text("x") });
    expect(() =>
      defineSchema({ tables: { a }, values: { a: { y: z.string() } } as never }),
    ).toThrow();
    expect(() => defineSchema({ tables: { a }, values: { b: {} } as never })).toThrow();
  });
});
