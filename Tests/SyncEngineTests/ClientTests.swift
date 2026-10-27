import GRDB
import XCTest
@testable import SyncEngine

@MainActor
final class ClientTests: XCTestCase {
    private func client(token: String? = "secret") throws -> (SyncClient, DatabasePool) {
        let pool = try Fixture.pool()
        let client = SyncClient(database: pool, schema: Fixture.schema, endpoint: URL(string: "http://127.0.0.1:9/v1/")!, token: { token }, session: StubServer.session())
        try client.migrate()
        return (client, pool)
    }

    func testARoundTripPushesTheOutboxAndAppliesTheResponse() async throws {
        let (client, pool) = try client()
        try pool.sql("INSERT INTO notes (id, title, stars) VALUES ('n1', 'Hi', 2)")
        try await waitUntil { client.pending == 1 }
        let rejected = RejectedWrite(seq: 1, table: "notes", id: "n1", reason: "title: too short")
        StubServer.reset(StubServer.json(200, Fixture.response(head: 5, acked: 1, rows: [Fixture.note("n1", title: "Server"), PulledRow(table: "tags", id: "t1", deleted: 0, values: ["name": .string("x"), "weight": .double(0.5)])], rejected: [rejected])))

        await client.sync()

        let received = StubServer.received
        XCTAssertEqual(received.map(\.url.absoluteString), ["http://127.0.0.1:9/v1/sync"])
        XCTAssertEqual(received[0].authorization, "Bearer secret")
        let clientID = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        let request = try JSONDecoder().decode(SyncRequest.self, from: received[0].body)
        XCTAssertEqual(request.protocol, 2)
        XCTAssertEqual(request.client, clientID)
        XCTAssertEqual(request.cursor, 0)
        XCTAssertEqual(request.writes, [SyncWrite(seq: 1, table: "notes", id: "n1", op: .put, values: ["title": .string("Hi"), "body": .null, "stars": .integer(2)])])
        XCTAssertEqual(client.status, .idle)
        XCTAssertEqual(client.head, 5)
        try await waitUntil { client.pending == 0 }
        XCTAssertNotNil(client.lastSyncAt)
        XCTAssertEqual(client.rejected, [SyncRejection(table: "notes", id: "n1", reason: "title: too short")])
        XCTAssertEqual(try pool.strings("SELECT title FROM notes"), ["Server"])
        XCTAssertEqual(try pool.strings("SELECT id || ':' || name || ':' || weight FROM tags"), ["t1:x:0.5"])
        XCTAssertEqual(try pool.outbox(), [])
    }

    func testBeforePushRunsBeforeWritesLeaveAndItsThrowKeepsThem() async throws {
        struct NotYet: Error {}
        let pool = try Fixture.pool()
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
        try await waitUntil { client.pending == 1 }
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 1)
        XCTAssertEqual(client.pending, 1)
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 2)
        XCTAssertEqual(StubServer.received[1].headers["x-app"], "test")
        try await waitUntil { client.pending == 0 }
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

    func testA401SetsUnauthorizedAndOnlyAnExplicitSyncTriesAgain() async throws {
        let (client, pool) = try client()
        StubServer.reset(.http(401, Data()))
        client.start()
        defer { client.stop() }
        try await waitUntil { client.status == .unauthorized }
        XCTAssertNil(client.lastSyncAt)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(StubServer.received.count, 1)
        StubServer.reply(StubServer.json(200, Fixture.response(head: 2, acked: 1)))
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 2)
        XCTAssertEqual(client.status, .idle)
    }

    func testASecondSyncWaitsForTheFirst() async throws {
        let (client, _) = try client()
        StubServer.reset(StubServer.json(200, Fixture.response(head: 5)), latency: 0.1)
        async let first: Void = client.sync()
        async let second: Void = client.sync()
        _ = await (first, second)
        let cursors = try StubServer.received.map { try JSONDecoder().decode(SyncRequest.self, from: $0.body).cursor }
        XCTAssertEqual(cursors, [0, 5])
    }

    func testAnAckAboveTheLargestSeqSentMintsANewClientAndKeepsTheOutbox() async throws {
        let (client, pool) = try client()
        let original = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        StubServer.reset(StubServer.json(200, Fixture.response(head: 9, acked: 7, rows: [Fixture.note("n2", title: "discarded")])))
        await client.sync()
        let minted = try pool.strings("SELECT value FROM _meta WHERE key = 'client'")[0]
        XCTAssertNotEqual(minted, original)
        XCTAssertNotNil(UUID(uuidString: minted))
        XCTAssertEqual(try pool.outbox().map(\.seq), [1])
        XCTAssertEqual(try pool.strings("SELECT id FROM notes"), ["n1"])
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 0)
        XCTAssertEqual(client.status, .idle)
        StubServer.reply(StubServer.json(200, Fixture.response(head: 10, acked: 1)))
        await client.sync()
        XCTAssertEqual(try StubServer.received.map { try JSONDecoder().decode(SyncRequest.self, from: $0.body).client }, [original, minted])
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
        StubServer.reset(.failure(.notConnectedToInternet))
        await client.sync()
        XCTAssertEqual(client.status, .offline)
        StubServer.reply(.http(503, Data()))
        await client.sync()
        XCTAssertEqual(client.status, .failed("HTTP 503"))
        StubServer.reply(.http(426, Data()))
        await client.sync()
        XCTAssertEqual(client.status, .failed("HTTP 426"))
        XCTAssertEqual(try pool.int("SELECT value FROM _meta WHERE key = 'cursor'"), 0)
    }

    func testALocalWriteAfterStartSchedulesASync() async throws {
        let (client, pool) = try client()
        StubServer.reset(StubServer.json(200, Fixture.response(head: 1, acked: 0)))
        client.start()
        defer { client.stop() }
        try await waitUntil { StubServer.received.count == 1 }
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        try await waitUntil { StubServer.received.count == 2 }
        let request = try JSONDecoder().decode(SyncRequest.self, from: StubServer.received[1].body)
        XCTAssertEqual(request.writes.map(\.id), ["n1"])
        XCTAssertEqual(request.cursor, 1)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(StubServer.received.count, 2)
    }

    func testALocalWriteDuringABackoffPullsTheRetryForward() async throws {
        let (client, pool) = try client()
        StubServer.reset(.failure(.notConnectedToInternet))
        client.start()
        defer { client.stop() }
        try await waitUntil { client.status == .offline }
        XCTAssertEqual(StubServer.received.count, 1)
        let written = ContinuousClock.now
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n1', 'a')")
        try await waitUntil { StubServer.received.count == 2 }
        XCTAssertLessThan(written.duration(to: StubServer.received[1].at), .milliseconds(500))
        let request = try JSONDecoder().decode(SyncRequest.self, from: StubServer.received[1].body)
        XCTAssertEqual(request.writes.map(\.id), ["n1"])
    }

    func testAForegroundEventAfterFailuresSyncsAtOnceAndResetsTheBackoff() async throws {
        let (client, _) = try client()
        StubServer.reset(.failure(.notConnectedToInternet))
        client.start()
        defer { client.stop() }
        try await waitUntil { client.status == .offline }
        await client.sync()
        await client.sync()
        XCTAssertEqual(StubServer.received.count, 3)
        let resumed = ContinuousClock.now
        await client.enteredForeground()
        XCTAssertEqual(StubServer.received.count, 4)
        XCTAssertLessThan(resumed.duration(to: StubServer.received.last!.at), .milliseconds(500))
        StubServer.reply(StubServer.json(200, Fixture.response(head: 1, acked: 0)))
        try await Task.sleep(for: .milliseconds(2500))
        // The socket loop's second attempt lands at the same 2 s and may add a pull of its own.
        XCTAssertGreaterThanOrEqual(StubServer.received.count, 5)
        XCTAssertLessThan(resumed.duration(to: StubServer.received[4].at), .seconds(3))
        XCTAssertEqual(client.status, .idle)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }
}

private actor Calls {
    private var count = 0
    func next() -> Int {
        count += 1
        return count
    }
}
