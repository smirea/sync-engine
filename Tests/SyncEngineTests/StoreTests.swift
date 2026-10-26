import GRDB
import Synchronization
import XCTest
@testable import SyncEngine

final class StoreTests: XCTestCase {
    func testInsertThenUpdateOfOneColumnIsOnePutWithTheFullRow() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title, body, stars) VALUES ('n1', 'Hi', NULL, 1)")
        try pool.sql("UPDATE notes SET title = 'Hello' WHERE id = 'n1'")
        let writes = try pool.read { try store.collect($0) }.writes
        XCTAssertEqual(writes, [SyncWrite(seq: 2, table: "notes", id: "n1", op: .put, values: ["title": .string("Hello"), "body": .null, "stars": .integer(1)])])
    }

    func testUpdatesOfTwoColumnsOnAnExistingRowAreOnePatchWithBoth() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.write { try store.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "Hi", body: "b", stars: 1)]), $0) }
        try pool.sql("UPDATE notes SET title = 'New', stars = 5 WHERE id = 'n1'")
        try pool.sql("UPDATE notes SET stars = 7 WHERE id = 'n1'")
        try pool.sql("UPDATE notes SET body = 'b' WHERE id = 'n1'")
        let writes = try pool.read { try store.collect($0) }.writes
        XCTAssertEqual(writes, [SyncWrite(seq: 3, table: "notes", id: "n1", op: .patch, values: ["title": .string("New"), "stars": .integer(7)])])
    }

    func testInsertThenDeleteIsOneDelete() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO tags (id, name) VALUES ('t1', 'a')")
        try pool.sql("UPDATE tags SET name = 'b' WHERE id = 't1'")
        try pool.sql("DELETE FROM tags WHERE id = 't1'")
        let writes = try pool.read { try store.collect($0) }.writes
        XCTAssertEqual(writes, [SyncWrite(seq: 3, table: "tags", id: "t1", op: .delete, values: nil)])
    }

    func testGroupsKeepTheOrderOfTheirFirstWrite() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        try pool.sql("INSERT INTO tags (id, name, weight) VALUES ('t1', 'x', 1.5)")
        try pool.sql("UPDATE notes SET title = 'b' WHERE id = 'n1'")
        let writes = try pool.read { try store.collect($0) }.writes
        XCTAssertEqual(writes.map { "\($0.table)/\($0.id)/\($0.seq)/\($0.op)" }, ["notes/n1/3/put", "tags/t1/2/put"])
        XCTAssertEqual(writes[1].values, ["name": .string("x"), "weight": .double(1.5), "color": .null])
    }

    func testAPutWhoseRowIsGoneIsDroppedAndClearedWithTheAckedRows() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        try pool.sql("INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 1)")
        try pool.sql("DELETE FROM notes WHERE id = 'n1'")
        try pool.sql("INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 0)")
        try pool.sql("INSERT INTO tags (id, name) VALUES ('t1', 'x')")
        XCTAssertEqual(try pool.outbox().map(\.op), ["insert", "insert"])
        let collected = try pool.read { try store.collect($0) }
        XCTAssertEqual(collected.writes, [SyncWrite(seq: 2, table: "tags", id: "t1", op: .put, values: ["name": .string("x"), "weight": .null, "color": .null])])
        XCTAssertEqual(collected.highest, 2)
        XCTAssertEqual(collected.sent, 2)
        try pool.write { try store.apply(Fixture.response(head: 3, acked: 2), acked: max(2, collected.highest), $0) }
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testASnapshotKeepsRowsWithPendingWrites() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.write { try store.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "server"), Fixture.note("n2", title: "stale")]), $0) }
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n3', 'local new')")
        try pool.sql("UPDATE notes SET title = 'local edit' WHERE id = 'n1'")
        let snapshot = Fixture.response(head: 9, acked: 0, snapshot: true, rows: [Fixture.note("n1", title: "server again"), Fixture.note("n4", title: "pulled")])
        try pool.write { try store.apply(snapshot, $0) }
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title FROM notes ORDER BY id"), ["n1:local edit", "n3:local new", "n4:pulled"])
        XCTAssertEqual(try pool.outbox().map(\.id), ["n3", "n1"])
    }

    func testAnUpsertKeepsChildRowsAndUntouchedColumns() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("CREATE TABLE children (id TEXT PRIMARY KEY, note_id TEXT REFERENCES notes(id) ON DELETE CASCADE)")
        try pool.write { try store.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "a", body: "keep")]), $0) }
        try pool.sql("INSERT INTO children (id, note_id) VALUES ('c1', 'n1')")
        try pool.write { try store.apply(Fixture.response(head: 2, rows: [PulledRow(table: "notes", id: "n1", deleted: 0, values: ["title": .string("b")])]), $0) }
        XCTAssertEqual(try pool.strings("SELECT title || ':' || body FROM notes"), ["b:keep"])
        XCTAssertEqual(try pool.int("SELECT count(*) FROM children"), 1)
    }

    func testBlobsAreRefused() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', x'0102')")
        XCTAssertThrowsError(try pool.read { try store.collect($0) }) { error in
            XCTAssertEqual(String(describing: error), "notes.title holds a blob; sync carries text, integer and real only")
        }
    }

    func testSnapshotReplacesEveryRow() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.write { try store.apply(Fixture.response(head: 2, rows: [Fixture.note("n1", title: "old"), PulledRow(table: "tags", id: "t1", deleted: 0, values: ["name": .string("x")])]), $0) }
        try pool.write { try store.apply(Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("n2", title: "new", stars: 3)]), $0) }
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title || ':' || stars FROM notes"), ["n2:new:3"])
        XCTAssertEqual(try pool.int("SELECT count(*) FROM tags"), 0)
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 9)
    }

    func testTombstoneDeletesAndUnknownColumnsAreIgnored() throws {
        let (pool, store) = try Fixture.migratedPool()
        var values = Fixture.note("n1", title: "a").values!
        values["later_column"] = .string("ignored")
        try pool.write { try store.apply(Fixture.response(head: 1, rows: [PulledRow(table: "notes", id: "n1", deleted: 0, values: values), Fixture.note("n2", title: "b")]), $0) }
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n2"])
        try pool.write { try store.apply(Fixture.response(head: 2, rows: [Fixture.tombstone("notes", "n1")]), $0) }
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), ["n2"])
    }

    func testAPulledRowWithAPendingOutboxEntryIsSkippedAndStaysPending() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'local 1')")
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n2', 'local 2')")
        let response = Fixture.response(head: 7, acked: 1, rows: [Fixture.note("n1", title: "server 1"), Fixture.note("n2", title: "server 2"), Fixture.tombstone("notes", "n2")])
        try pool.write { try store.apply(response, $0) }
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title FROM notes ORDER BY id"), ["n1:server 1", "n2:local 2"])
        XCTAssertEqual(try pool.outbox(), [OutboxRow(seq: 2, table: "notes", id: "n2", op: "insert", col: nil)])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 7)
    }

    func testAnUnchangedPulledRowIsNotRewrittenAndAChangedOneIs() throws {
        let (pool, store) = try Fixture.migratedPool()
        let tag = { (weight: JSONValue) in PulledRow(table: "tags", id: "t1", deleted: 0, values: ["name": .string("x"), "weight": weight, "color": .null]) }
        try pool.write { try store.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "a"), tag(.integer(2))]), $0) }
        let commits = Mutex<[String]>([])
        let observation = DatabaseRegionObservation(tracking: Table("notes"), Table("tags"))
        let cancellable = try observation.start(in: pool, onError: { XCTFail("\($0)") }, onChange: { db in
            let notes = try! String.fetchAll(db, sql: "SELECT title || ':' || coalesce(body, 'null') FROM notes")
            commits.withLock { $0.append(notes.joined(separator: ",")) }
        })
        defer { cancellable.cancel() }

        try pool.write { try store.apply(Fixture.response(head: 2, rows: [Fixture.note("n1", title: "a"), tag(.integer(2))]), $0) }
        XCTAssertEqual(commits.withLock { $0 }, [])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 2)

        try pool.write { try store.apply(Fixture.response(head: 3, rows: [Fixture.note("n1", title: "a", body: "b")]), $0) }
        try pool.write { try store.apply(Fixture.response(head: 4, rows: [Fixture.note("n1", title: "a")]), $0) }
        XCTAssertEqual(commits.withLock { $0 }, ["a:b", "a:null"])
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testTriggersAreSilentDuringApply() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.write { try store.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "a")]), $0) }
        let response = Fixture.response(head: 3, rows: [Fixture.note("n1", title: "b"), Fixture.note("n2", title: "c"), Fixture.tombstone("notes", "n2")])
        try pool.write { try store.apply(response, $0) }
        XCTAssertEqual(try pool.outbox(), [])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'applying'"), 0)
        try pool.sql("UPDATE notes SET title = 'c' WHERE id = 'n1'")
        XCTAssertEqual(try pool.outbox(), [OutboxRow(seq: 1, table: "notes", id: "n1", op: "update", col: "title")])
    }

    func testMigrateIsIdempotentAndMintsTheClientOnce() throws {
        let (pool, store) = try Fixture.migratedPool()
        let client = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")
        XCTAssertEqual(client.count, 1)
        XCTAssertNotNil(UUID(uuidString: client[0]))
        try pool.sql("INSERT OR REPLACE INTO _meta (key, value) VALUES ('cursor', 4)")
        try pool.write { try store.migrate($0) }
        XCTAssertEqual(try pool.strings("SELECT value FROM _meta WHERE key = 'client'"), client)
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 4)
    }

    func testMigrateAddsAColumnOnceAndNamesOneTheDDLForgot() throws {
        let pool = try Fixture.pool()
        try pool.sql("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, weight REAL)")
        try pool.write { try SyncStore(schema: Fixture.schema).migrate($0) }
        XCTAssertEqual(try pool.strings("SELECT name FROM pragma_table_info('tags')"), ["id", "name", "weight", "color"])
        let grown = SyncSchema(tables: [SyncTable(name: "tags", columns: ["name", "weight", "color", "rank"])], statements: Fixture.schema.statements)
        XCTAssertThrowsError(try pool.write { try SyncStore(schema: grown).migrate($0) }) { error in
            XCTAssertEqual(String(describing: error), "tags.rank is in the schema but not in the database; the DDL must add it")
        }
    }
}
