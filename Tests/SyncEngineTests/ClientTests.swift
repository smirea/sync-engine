import Foundation
import GRDB
import XCTest
@testable import SyncEngine

@MainActor
final class ClientTests: XCTestCase {
    private let path = FileManager.default.temporaryDirectory.appending(path: "client-\(UUID().uuidString).sqlite").path

    private func client(token: String? = "secret") throws -> (SyncClient, DatabasePool) {
        let pool = try DatabasePool(path: path)
        let client = SyncClient(database: pool, schema: Fixture.schema, endpoint: URL(string: "http://127.0.0.1:9/v1/")!, token: { token }, session: StubServer.session())
        try client.migrate()
        return (client, pool)
    }

    private static func requests() throws -> [SyncRequest] {
        try StubServer.received.map { try JSONDecoder().decode(SyncRequest.self, from: $0.body) }
    }

    private static func page(head: Int, acked: Int = 0, _ rows: [PulledRow], next: After?) -> StubServer.Reply {
        StubServer.json(200, Fixture.response(head: head, acked: acked, snapshot: true, rows: rows, next: next))
    }

    private func meta(_ pool: DatabasePool) throws -> [String] {
        try pool.strings("SELECT key || '=' || value FROM _meta WHERE key IN ('cursor', 'after', 'snapshot_head', 'refresh') ORDER BY key")
    }

    func testARoundTripPushesTheOutboxAndAppliesTheResponse() async throws {
        let (client, pool) = try client()
        try pool.sql("INSERT INTO notes (id, title, stars) VALUES ('n1', 'Hi', 2)")
        let rejected = RejectedWrite(seq: 1, table: "notes", id: "n1", reason: "title: too short")
        StubServer.reset(StubServer.json(200, Fixture.response(head: 5, acked: 1, rows: [Fixture.note("n1", title: "Server"), PulledRow(table: "tags", id: "t1", deleted: 0, values: ["name": .string("x"), "weight": .double(0.5)])], rejected: [rejected])))

        await client.sync()

        let received = StubServer.received
        XCTAssertEqual(received.map(\.url.absoluteString), ["http://127.0.0.1:9/v1/sync"])
        XCTAssertEqual(received[0].authorization, "Bearer secret")
        let clientID = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        let request = try Self.requests()[0]
        XCTAssertEqual(request.protocol, 2)
        XCTAssertEqual(request.client, clientID)
        XCTAssertEqual(request.cursor, 0)
        XCTAssertEqual(request.space, "")
        XCTAssertEqual(request.writes, [SyncWrite(seq: 1, table: "notes", id: "n1", op: .put, values: ["title": .string("Hi"), "body": .null, "stars": .integer(2)])])
        XCTAssertEqual(client.status, .idle)
        XCTAssertEqual(client.head, 5)
        XCTAssertNotNil(client.lastSyncAt)
        XCTAssertEqual(client.rejected, [SyncRejection(table: "notes", id: "n1", reason: "title: too short")])
        XCTAssertEqual(try pool.strings("SELECT title FROM notes"), ["Server"])
        XCTAssertEqual(try pool.strings("SELECT id || ':' || name || ':' || weight FROM tags"), ["t1:x:0.5"])
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testBeforePushRunsBeforeWritesLeaveAndItsThrowKeepsThem() async throws {
        struct NotYet: Error {}
        let pool = try DatabasePool(path: path)
        let calls = Calls()
        let client = SyncClient(
            database: pool, schema: Fixture.schema, endpoint: URL(string: "http://127.0.0.1:9/v1/")!, token: { "secret" },
            session: StubServer.session(), headers: ["x-app": "test"],
            beforePush: { if await calls.next() == 1 { throw NotYet() } }
        )
        try client.migrate()
        StubServer.reset(StubServer.json(200, Fixture.response(head: 1, acked: 1)))
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 1)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 1)
        XCTAssertEqual(try pool.outbox().count, 1)
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 2)
        XCTAssertEqual(StubServer.received[1].headers["x-app"], "test")
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testResetEmptiesTheTablesAndTheOutboxUnderANewClient() async throws {
        let (client, pool) = try client()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        let before = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        try await client.reset()
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), [])
        XCTAssertEqual(try pool.outbox(), [])
        XCTAssertNotEqual(try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0], before)
        XCTAssertEqual(client.head, 0)
    }

    func testA401IsUnauthorizedUntilAnExplicitSyncSucceeds() async throws {
        let (client, _) = try client()
        StubServer.reset(.http(401, Data()), StubServer.json(200, Fixture.response(head: 2)))
        await client.sync()
        XCTAssertEqual(client.status, .unauthorized)
        XCTAssertNil(client.lastSyncAt)
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 2)
        XCTAssertEqual(client.status, .idle)
    }

    func testASecondSyncWaitsForTheFirst() async throws {
        let (client, _) = try client()
        StubServer.reset(StubServer.json(200, Fixture.response(head: 5)))
        async let first: Void = client.sync()
        async let second: Void = client.sync()
        _ = await (first, second)
        XCTAssertEqual(try Self.requests().map(\.cursor), [0, 5])
    }

    func testAnAckAboveTheLargestSeqSentMintsANewClientAndKeepsTheOutbox() async throws {
        let (client, pool) = try client()
        let original = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        StubServer.reset(StubServer.json(200, Fixture.response(head: 9, acked: 7, rows: [Fixture.note("n2", title: "discarded")])), StubServer.json(200, Fixture.response(head: 10, acked: 1)))
        await client.sync()
        let minted = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        XCTAssertNotEqual(minted, original)
        XCTAssertEqual(try pool.outbox().map(\.seq), [1])
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), ["n1"])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 0)
        XCTAssertEqual(client.status, .idle)
        await client.sync()
        XCTAssertEqual(try Self.requests().map(\.client), [original, minted])
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testAMissingTokenIsUnauthorizedWithoutARequest() async throws {
        let (client, _) = try client(token: nil)
        StubServer.reset(.http(200, Data()))
        await client.sync()
        XCTAssertEqual(client.status, .unauthorized)
        XCTAssertEqual(StubServer.received.count, 0)
    }

    func testAURLErrorIsOfflineAndA5xxIsFailed() async throws {
        let (client, pool) = try client()
        StubServer.reset(.failure(.notConnectedToInternet), .http(503, Data()), .http(426, Data()))
        await client.sync()
        XCTAssertEqual(client.status, .offline)
        await client.sync()
        XCTAssertEqual(client.status, .failed("HTTP 503"))
        await client.sync()
        XCTAssertEqual(client.status, .failed("HTTP 426"))
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 0)
    }

    func testAPagedSnapshotRunsInOneSyncAndSendsTheOutboxOnlyWithTheFirstPage() async throws {
        let (client, pool) = try client()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n5', 'MINE')")
        StubServer.reset(
            Self.page(head: 7, acked: 1, [Fixture.note("n1", title: "N1"), Fixture.note("n2", title: "N2")], next: After(table: "notes", id: "n2")),
            Self.page(head: 7, [Fixture.note("n3", title: "N3"), Fixture.note("n4", title: "N4")], next: After(table: "notes", id: "n4")),
            Self.page(head: 7, [Fixture.note("n5", title: "MINE"), Fixture.tag("t1")], next: nil)
        )

        await client.sync()

        XCTAssertEqual(try Self.requests().map { "\($0.cursor) \($0.after?.id ?? "-") \($0.writes.count)" }, ["0 - 1", "0 n2 0", "0 n4 0"])
        XCTAssertEqual(try pool.strings("SELECT id || ':' || title FROM notes ORDER BY id"), ["n1:N1", "n2:N2", "n3:N3", "n4:N4", "n5:MINE"])
        XCTAssertEqual(try pool.strings("SELECT id FROM tags"), ["t1"])
        XCTAssertEqual(try meta(pool), ["cursor=7"])
        XCTAssertEqual(try pool.outbox(), [])
        XCTAssertEqual(client.head, 7)
        XCTAssertNil(client.snapshotRows)
        XCTAssertEqual(client.status, .idle)
    }

    func testARestartBetweenPagesResumesFromAfterAndKeepsTheEarlierPages() async throws {
        do {
            let (client, pool) = try client()
            StubServer.reset(
                Self.page(head: 7, [Fixture.note("n1", title: "N1"), Fixture.note("n2", title: "N2")], next: After(table: "notes", id: "n2")),
                Self.page(head: 7, [Fixture.note("n3", title: "N3"), Fixture.note("n4", title: "N4")], next: After(table: "notes", id: "n4")),
                .failure(.networkConnectionLost)
            )
            await client.sync()
            XCTAssertEqual(client.status, .offline)
            XCTAssertEqual(client.snapshotRows, 4)
            XCTAssertEqual(try meta(pool), [#"after={"id":"n4","table":"notes"}"#, "cursor=0", "snapshot_head=7"])
            try pool.close()
        }
        let (client, pool) = try client()
        try pool.sql("INSERT INTO notes (id, title) VALUES ('mine', 'MINE')")
        XCTAssertEqual(client.snapshotRows, 0)
        StubServer.reset(
            Self.page(head: 8, acked: 1, [Fixture.note("mine", title: "MINE"), Fixture.tag("t1")], next: After(table: "tags", id: "t1")),
            Self.page(head: 8, [Fixture.tag("t2")], next: nil)
        )

        await client.sync()

        XCTAssertEqual(try Self.requests().map { "\($0.cursor) \($0.after?.id ?? "-") \($0.writes.count)" }, ["0 n4 1", "0 t1 0"])
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["mine", "n1", "n2", "n3", "n4"])
        XCTAssertEqual(try pool.strings("SELECT id FROM tags ORDER BY id"), ["t1", "t2"])
        XCTAssertEqual(try meta(pool), ["cursor=7"])
        XCTAssertNil(client.snapshotRows)
        XCTAssertEqual(client.status, .idle)
    }

    func testARefreshRunsItsPagesAndTheDeltaInOneSyncWithoutReportingASnapshot() async throws {
        let (client, pool) = try client()
        StubServer.reset(StubServer.json(200, Fixture.response(head: 4, rows: [Fixture.note("n1", title: "N1"), Fixture.tag("t1")])))
        await client.sync()
        try pool.sql(#"INSERT INTO _meta (key, value) VALUES ('refresh', '{"tables":["tags"]}')"#)
        StubServer.reset(
            StubServer.json(200, Fixture.response(head: 6, snapshot: true, rows: [Fixture.tag("t1")], next: After(table: "tags", id: "t1"), tables: ["tags"])),
            StubServer.json(200, Fixture.response(head: 6, snapshot: true, rows: [Fixture.tag("t2")], tables: ["tags"])),
            StubServer.json(200, Fixture.response(head: 6, rows: [Fixture.note("n2", title: "N2")]))
        )

        await client.sync()

        XCTAssertEqual(try Self.requests().map { "\($0.cursor) \($0.refresh?.tables ?? []) \($0.refresh?.after?.id ?? "-")" }, [#"4 ["tags"] -"#, #"4 ["tags"] t1"#, "4 [] -"])
        XCTAssertEqual(try pool.strings("SELECT id FROM notes ORDER BY id"), ["n1", "n2"])
        XCTAssertEqual(try pool.strings("SELECT id FROM tags ORDER BY id"), ["t1", "t2"])
        XCTAssertEqual(try meta(pool), ["cursor=6"])
        XCTAssertEqual(client.head, 6)
        XCTAssertNil(client.snapshotRows)
        XCTAssertEqual(client.status, .idle)
    }

    func testAPagedSnapshotEndsOnTheFirstPageHeadSoWritesDuringItArriveWithTheNextDelta() async throws {
        let (client, pool) = try client()
        StubServer.reset(
            Self.page(head: 7, [Fixture.note("n1", title: "N1"), Fixture.note("n2", title: "N2")], next: After(table: "notes", id: "n2")),
            Self.page(head: 8, [Fixture.note("n3", title: "N3")], next: nil),
            StubServer.json(200, Fixture.response(head: 8, rows: [Fixture.note("n1", title: "EDITED")]))
        )

        await client.sync()
        XCTAssertEqual(client.head, 7)
        XCTAssertEqual(try meta(pool), ["cursor=7"])
        await client.sync()

        XCTAssertEqual(try Self.requests().last?.cursor, 7)
        XCTAssertEqual(try pool.strings("SELECT title FROM notes WHERE id = 'n1'"), ["EDITED"])
        XCTAssertEqual(try meta(pool), ["cursor=8"])
    }

    nonisolated func testAPingResolvesWithAPongThatAnAbortFollows() async throws {
        try await firstAnswer { answer in
            answer(nil)
            answer(NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNABORTED)))
        }
    }

    nonisolated func testAPingAnsweredByTwoErrorsThrowsTheFirst() async {
        do {
            try await firstAnswer { answer in
                answer(NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNREFUSED)))
                answer(NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNABORTED)))
            }
            XCTFail("ping resolved")
        } catch {
            XCTAssertEqual((error as NSError).code, Int(ECONNREFUSED))
        }
    }
}

private actor Calls {
    private var count = 0
    func next() -> Int {
        count += 1
        return count
    }
}
