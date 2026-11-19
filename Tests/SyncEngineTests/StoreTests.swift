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
        try pool.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "Hi", body: "b", stars: 1)]), store)
        try pool.sql("UPDATE notes SET title = 'New', stars = 5 WHERE id = 'n1'")
        try pool.sql("UPDATE notes SET stars = 7 WHERE id = 'n1'")
        try pool.sql("UPDATE notes SET body = 'b' WHERE id = 'n1'")
        let writes = try pool.read { try store.collect($0) }.writes
        XCTAssertEqual(writes, [SyncWrite(seq: 3, table: "notes", id: "n1", op: .patch, values: ["title": .string("New"), "stars": .integer(7)])])
    }

    /// A store that synced `n1` and `n2` and a tag at cursor 4 before `notes` had `stars`, migrated to the schema that has it.
    private func grown(paging: Bool = false) throws -> (DatabasePool, SyncStore) {
        let pool = try Fixture.pool()
        var statements = Fixture.schema.statements.filter { !$0.contains("_ob_u_notes_stars") }
        statements[0] = "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT)"
        let old = SyncStore(schema: SyncSchema(tables: [SyncTable(name: "notes", columns: ["title", "body"]), Fixture.schema.tables[1]], statements: statements))
        try pool.write { try old.migrate($0) }
        try pool.apply(Fixture.response(head: 4, rows: [Fixture.note("n1", title: "a", stars: 3), Fixture.note("n2", title: "b"), Fixture.tag("t1")], space: "s"), old)
        if paging {
            try pool.apply(Fixture.response(head: 6, snapshot: true, rows: [Fixture.note("n1", title: "a", stars: 3)], next: After(table: "notes", id: "n1")), old)
        }
        statements = Fixture.schema.statements
        statements.insert("ALTER TABLE notes ADD COLUMN stars INTEGER NOT NULL DEFAULT 0", at: 1)
        let store = SyncStore(schema: SyncSchema(tables: Fixture.schema.tables, statements: statements))
        try pool.write { try store.migrate($0) }
        return (pool, store)
    }

    func testAGrownSchemaKeepsItsCursorAndAsksOnlyForTheGrownTablesSoValuesSetBeforeTheUpgradeArrive() throws {
        let (pool, store) = try grown()
        XCTAssertEqual(try pool.read { try store.cursor($0) }, 4)
        let request = try pool.read { try store.request(client: "c", writes: [], $0) }
        XCTAssertEqual(request.refresh, Refresh(tables: ["notes"]))
        XCTAssertEqual(request.cursor, 4)

        let first = Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("n1", title: "a", stars: 3)], next: After(table: "notes", id: "n1"), tables: ["notes"])
        XCTAssertTrue(try pool.apply(first, store))
        XCTAssertEqual(try pool.read { try store.request(client: "c", writes: [], $0) }.refresh, Refresh(tables: ["notes"], after: After(table: "notes", id: "n1")))
        XCTAssertTrue(try pool.apply(Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("n2", title: "b", stars: 5)], tables: ["notes"]), store))
        XCTAssertEqual(try pool.strings("SELECT id || ':' || stars FROM notes ORDER BY id"), ["n1:3", "n2:5"])

        let delta = try pool.read { try store.request(client: "c", writes: [], $0) }
        XCTAssertNil(delta.refresh)
        XCTAssertEqual(delta.cursor, 4)
        XCTAssertFalse(try pool.apply(Fixture.response(head: 9), store))
        XCTAssertEqual(try pool.read { try store.cursor($0) }, 9)

        try pool.write { try store.migrate($0) }
        XCTAssertNil(try pool.read { try store.refresh($0) })
    }

    func testTheLastPageOfARefreshRemovesTheRowsItsTablesNoLongerHoldAndLeavesEveryOtherTableAlone() throws {
        let (pool, store) = try grown()
        try pool.apply(Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("n2", title: "b")], tables: ["notes"]), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), ["n2"])
        XCTAssertEqual(try pool.strings("SELECT id FROM tags"), ["t1"])
        XCTAssertEqual(try pool.read { try store.cursor($0) }, 4)
    }

    func testADeltaThatAnswersARefreshComesFromAServerOlderThanRefreshSoAFullSnapshotFollows() throws {
        let (pool, store) = try grown()
        XCTAssertTrue(try pool.apply(Fixture.response(head: 5, rows: [Fixture.note("n3", title: "c")]), store))
        let request = try pool.read { try store.request(client: "c", writes: [], $0) }
        XCTAssertEqual(request.cursor, 0)
        XCTAssertNil(request.refresh)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n2", "n3"])
    }

    func testAFullSnapshotThatAnswersARefreshCoversItAndEndsIt() throws {
        let (pool, store) = try grown()
        XCTAssertFalse(try pool.apply(Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("n1", title: "a", stars: 3)]), store))
        XCTAssertNil(try pool.read { try store.refresh($0) })
        XCTAssertEqual(try pool.strings("SELECT id || ':' || stars FROM notes"), ["n1:3"])
        XCTAssertEqual(try pool.int("SELECT count(*) FROM tags"), 0)
        XCTAssertEqual(try pool.read { try store.cursor($0) }, 9)
    }

    func testASchemaThatGrowsDuringASnapshotStartsTheSnapshotOver() throws {
        let (pool, store) = try grown(paging: true)
        let request = try pool.read { try store.request(client: "c", writes: [], $0) }
        XCTAssertEqual(request.cursor, 0)
        XCTAssertNil(request.after)
        XCTAssertNil(request.refresh)
    }

    func testASnapshotBegunBeforeTheStoreRecordedTheRowsItSawStartsOver() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 8, snapshot: true, rows: [Fixture.note("n1", title: "a")], next: After(table: "notes", id: "n1")), store)
        // What a store from before `_seen` leaves behind when the app is updated between two pages.
        try pool.sql("DROP TABLE _seen")

        try pool.write { try store.migrate($0) }
        let request = try pool.read { try store.request(client: "c", writes: [], $0) }
        XCTAssertEqual(request.cursor, 0)
        XCTAssertNil(request.after)
    }

    func testASnapshotOfRowsTheStoreAlreadyHoldsFiresNoObservationOnAnyPage() throws {
        let (pool, store) = try Fixture.migratedPool()
        let rows = [Fixture.note("n1", title: "a"), Fixture.note("n2", title: "b", body: "x", stars: 2), Fixture.tag("t1")]
        try pool.apply(Fixture.response(head: 3, rows: rows), store)
        let commits = Mutex(0)
        let cancellable = DatabaseRegionObservation(tracking: Table("notes"), Table("tags"))
            .start(in: pool, onError: { XCTFail("\($0)") }, onChange: { _ in commits.withLock { $0 += 1 } })
        defer { cancellable.cancel() }

        XCTAssertTrue(try pool.apply(Fixture.response(head: 8, snapshot: true, rows: Array(rows[..<2]), next: After(table: "notes", id: "n2")), store))
        XCTAssertFalse(try pool.apply(Fixture.response(head: 8, snapshot: true, rows: [rows[2]]), store))
        XCTAssertEqual(commits.withLock { $0 }, 0)
        XCTAssertEqual(try pool.read { try store.cursor($0) }, 8)

        try pool.apply(Fixture.response(head: 9, snapshot: true, rows: Array(rows[..<2])), store)
        XCTAssertEqual(commits.withLock { $0 }, 1)
        XCTAssertEqual(try pool.int("SELECT count(*) FROM tags"), 0)
    }

    func testRowsTheServerDroppedGoOnlyWhenTheLastPageLands() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 3, rows: [Fixture.note("n1", title: "a"), Fixture.note("n2", title: "b"), Fixture.tag("t1")]), store)
        try pool.apply(Fixture.response(head: 8, snapshot: true, rows: [Fixture.note("n2", title: "b")], next: After(table: "notes", id: "n2")), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n2"])
        XCTAssertEqual(try pool.strings("SELECT id FROM tags"), ["t1"])
        try pool.apply(Fixture.response(head: 8, snapshot: true, rows: [Fixture.tag("t2")]), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), ["n2"])
        XCTAssertEqual(try pool.strings("SELECT id FROM tags"), ["t2"])
    }

    func testARowPushedWhileASnapshotIsPagingStaysWhenItsLastPageLands() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 8, snapshot: true, rows: [Fixture.note("n3", title: "c")], next: After(table: "notes", id: "n3")), store)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'sorts before the page already taken')")
        let sent = try pool.read { try store.collect($0) }.sent
        try pool.apply(Fixture.response(head: 9, acked: sent, snapshot: true, rows: [Fixture.note("n4", title: "d")]), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n3", "n4"])
        XCTAssertEqual(try pool.outbox(), [])
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
        try pool.apply(Fixture.response(head: 3, acked: 2), acked: max(2, collected.highest), store)
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testAResponseFromAnotherSpaceStartsASnapshotOverEvenMidSnapshot() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 7, snapshot: true, rows: [Fixture.note("old1", title: "a")], space: "old"), store)
        XCTAssertEqual(try pool.strings("SELECT key || '=' || value FROM _meta WHERE key IN ('cursor', 'space') ORDER BY key"), ["cursor=7", "space=old"])
        try pool.apply(Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("old2", title: "b")], next: After(table: "notes", id: "old2"), space: "old"), store)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('mine', 'offline')")

        try pool.apply(Fixture.response(head: 3, snapshot: true, rows: [Fixture.note("new1", title: "c")], space: "new"), store)

        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["mine", "new1"])
        XCTAssertEqual(try pool.strings("SELECT key || '=' || value FROM _meta WHERE key IN ('after', 'cursor', 'snapshot_head', 'space') ORDER BY key"), ["cursor=3", "space=new"])
    }

    func testAResponseWithoutASpaceLeavesTheStoredOneAlone() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 2, snapshot: true, rows: [Fixture.note("n1", title: "a")], space: "s"), store)
        try pool.apply(Fixture.response(head: 3, rows: [Fixture.note("n2", title: "b")]), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n2"])
        XCTAssertEqual(try pool.strings("SELECT value FROM _meta WHERE key = 'space'"), ["s"])
    }

    func testASnapshotKeepsRowsWithPendingWrites() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "server"), Fixture.note("n2", title: "stale")]), store)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n3', 'local new')")
        try pool.sql("UPDATE notes SET title = 'local edit' WHERE id = 'n1'")
        let snapshot = Fixture.response(head: 9, acked: 0, snapshot: true, rows: [Fixture.note("n1", title: "server again"), Fixture.note("n4", title: "pulled")])
        try pool.apply(snapshot, store)
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title FROM notes ORDER BY id"), ["n1:local edit", "n3:local new", "n4:pulled"])
        XCTAssertEqual(try pool.outbox().map(\.id), ["n3", "n1"])
    }

    func testAnUpsertKeepsChildRowsAndUntouchedColumns() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("CREATE TABLE children (id TEXT PRIMARY KEY, note_id TEXT REFERENCES notes(id) ON DELETE CASCADE)")
        try pool.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "a", body: "keep")]), store)
        try pool.sql("INSERT INTO children (id, note_id) VALUES ('c1', 'n1')")
        try pool.apply(Fixture.response(head: 2, rows: [PulledRow(table: "notes", id: "n1", deleted: 0, values: ["title": .string("b")])]), store)
        XCTAssertEqual(try pool.strings("SELECT title || ':' || body FROM notes"), ["b:keep"])
        XCTAssertEqual(try pool.int("SELECT count(*) FROM children"), 1)
    }

    func testBlobsAreRefused() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', x'0102')")
        XCTAssertThrowsError(try pool.read { try store.collect($0) }) { XCTAssertTrue($0 is SyncSchemaError) }
    }

    func testSnapshotReplacesEveryRow() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 2, rows: [Fixture.note("n1", title: "old"), PulledRow(table: "tags", id: "t1", deleted: 0, values: ["name": .string("x")])]), store)
        try pool.apply(Fixture.response(head: 9, snapshot: true, rows: [Fixture.note("n2", title: "new", stars: 3)]), store)
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title || ':' || stars FROM notes"), ["n2:new:3"])
        XCTAssertEqual(try pool.int("SELECT count(*) FROM tags"), 0)
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 9)
    }

    func testTombstoneDeletesAndUnknownColumnsAreIgnored() throws {
        let (pool, store) = try Fixture.migratedPool()
        var values = Fixture.note("n1", title: "a").values!
        values["later_column"] = .string("ignored")
        try pool.apply(Fixture.response(head: 1, rows: [PulledRow(table: "notes", id: "n1", deleted: 0, values: values), Fixture.note("n2", title: "b")]), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n2"])
        try pool.apply(Fixture.response(head: 2, rows: [Fixture.tombstone("notes", "n1")]), store)
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), ["n2"])
    }

    func testAPulledRowWithAPendingOutboxEntryIsSkippedAndStaysPending() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'local 1')")
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n2', 'local 2')")
        let response = Fixture.response(head: 7, acked: 1, rows: [Fixture.note("n1", title: "server 1"), Fixture.note("n2", title: "server 2"), Fixture.tombstone("notes", "n2")])
        try pool.apply(response, store)
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title FROM notes ORDER BY id"), ["n1:server 1", "n2:local 2"])
        XCTAssertEqual(try pool.outbox(), [OutboxRow(seq: 2, table: "notes", id: "n2", op: "insert", col: nil)])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 7)
    }

    func testAnUnchangedPulledRowIsNotRewrittenAndAChangedOneIs() throws {
        let (pool, store) = try Fixture.migratedPool()
        let tag = { (weight: JSONValue) in PulledRow(table: "tags", id: "t1", deleted: 0, values: ["name": .string("x"), "weight": weight, "color": .null]) }
        try pool.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "a"), tag(.integer(2))]), store)
        let commits = Mutex<[String]>([])
        let observation = DatabaseRegionObservation(tracking: Table("notes"), Table("tags"))
        let cancellable = try observation.start(in: pool, onError: { XCTFail("\($0)") }, onChange: { db in
            let notes = try! String.fetchAll(db, sql: "SELECT title || ':' || coalesce(body, 'null') FROM notes")
            commits.withLock { $0.append(notes.joined(separator: ",")) }
        })
        defer { cancellable.cancel() }

        try pool.apply(Fixture.response(head: 2, rows: [Fixture.note("n1", title: "a"), tag(.integer(2))]), store)
        XCTAssertEqual(commits.withLock { $0 }, [])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 2)

        try pool.apply(Fixture.response(head: 3, rows: [Fixture.note("n1", title: "a", body: "b")]), store)
        try pool.apply(Fixture.response(head: 4, rows: [Fixture.note("n1", title: "a")]), store)
        XCTAssertEqual(commits.withLock { $0 }, ["a:b", "a:null"])
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testTriggersAreSilentDuringApply() throws {
        let (pool, store) = try Fixture.migratedPool()
        try pool.apply(Fixture.response(head: 1, rows: [Fixture.note("n1", title: "a")]), store)
        let response = Fixture.response(head: 3, rows: [Fixture.note("n1", title: "b"), Fixture.note("n2", title: "c"), Fixture.tombstone("notes", "n2")])
        try pool.apply(response, store)
        XCTAssertEqual(try pool.outbox(), [])
        try pool.sql("UPDATE notes SET title = 'c' WHERE id = 'n1'")
        XCTAssertEqual(try pool.outbox(), [OutboxRow(seq: 1, table: "notes", id: "n1", op: "update", col: "title")])
    }

    func testMigrateIsIdempotentAndMintsTheClientOnce() throws {
        let (pool, store) = try Fixture.migratedPool()
        let client = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")
        XCTAssertEqual(client.count, 1)
        try pool.sql("INSERT OR REPLACE INTO _meta (key, value) VALUES ('cursor', 4)")
        try pool.write { try store.migrate($0) }
        XCTAssertEqual(try pool.strings("SELECT value FROM _meta WHERE key = 'client'"), client)
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 4)
    }

    func testMigrateAddsAColumnOnceAndRefusesOneTheDDLForgot() throws {
        let pool = try Fixture.pool()
        try pool.sql("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, weight REAL)")
        try pool.write { try SyncStore(schema: Fixture.schema).migrate($0) }
        XCTAssertEqual(try pool.strings("SELECT name FROM pragma_table_info('tags')"), ["id", "name", "weight", "color"])
        let grown = SyncSchema(tables: [SyncTable(name: "tags", columns: ["name", "weight", "color", "rank"])], statements: Fixture.schema.statements)
        XCTAssertThrowsError(try pool.write { try SyncStore(schema: grown).migrate($0) }) { XCTAssertTrue($0 is SyncSchemaError) }
    }
}
