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
        XCTAssertEqual(request.protocol, 1)
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

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }
}
