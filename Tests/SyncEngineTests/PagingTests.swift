import GRDB
import Synchronization
import XCTest
@testable import SyncEngine

@MainActor
final class PagingTests: XCTestCase {
    private let path = FileManager.default.temporaryDirectory.appending(path: "paging-\(UUID().uuidString).sqlite").path

    override func setUp() {
        Relay.reset()
    }

    private func client(_ server: BunServer) throws -> (SyncClient, DatabasePool) {
        let pool = try DatabasePool(path: path)
        let client = SyncClient(database: pool, schema: Fixture.schema, endpoint: server.url, token: { "secret" }, session: Relay.session())
        try client.migrate()
        return (client, pool)
    }

    private static func put(_ seq: Int, _ table: String, _ id: String) -> SyncWrite {
        SyncWrite(seq: seq, table: table, id: id, op: .put, values: [table == "notes" ? "title" : "name": .string(id.uppercased())])
    }

    @discardableResult
    private static func other(_ server: BunServer, _ writes: [SyncWrite] = []) async throws -> SyncResponse {
        try await BunServer.post(SyncRequest(protocol: 2, client: "other", cursor: 0, writes: writes, after: nil), to: server.url)
    }

    private static let seven = ["n1", "n2", "n3", "n4", "n5"].enumerated().map { put($0.offset + 1, "notes", $0.element) } + [put(6, "tags", "t1"), put(7, "tags", "t2")]

    private static func pages() throws -> [String] {
        try Relay.requests.map { "\($0.cursor) \($0.after.map { "\($0.table)/\($0.id)" } ?? "-") \($0.writes.count)" }
    }

    private func rows(_ pool: DatabasePool) throws -> [String] {
        try pool.strings("SELECT 'notes/' || id || ':' || title FROM notes UNION ALL SELECT 'tags/' || id || ':' || name FROM tags ORDER BY 1")
    }

    private func meta(_ pool: DatabasePool) throws -> [String] {
        try pool.strings("SELECT key || '=' || value FROM _meta WHERE key IN ('cursor', 'after', 'snapshot_head') ORDER BY key")
    }

    func testAPagedSnapshotOfSevenRowsConvergesInOneSync() async throws {
        let server = try BunServer(space: ["pageSize": 2])
        try await Self.other(server, Array(Self.seven.prefix(5)) + [Self.put(6, "tags", "t1")])
        let (client, pool) = try client(server)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('n6', 'MINE')")
        let seen = Mutex<[Int?]>([])
        Relay.reset { _ in
            let rows = await client.snapshotRows
            seen.withLock { $0.append(rows) }
        }

        await client.sync()

        XCTAssertEqual(try Self.pages(), ["0 - 1", "0 notes/n2 0", "0 notes/n4 0", "0 notes/n6 0"])
        XCTAssertEqual(seen.withLock { $0 }, [nil, 2, 4, 6])
        XCTAssertEqual(try rows(pool), ["notes/n1:N1", "notes/n2:N2", "notes/n3:N3", "notes/n4:N4", "notes/n5:N5", "notes/n6:MINE", "tags/t1:T1"])
        XCTAssertEqual(try meta(pool), ["cursor=7"])
        XCTAssertEqual(try pool.outbox(), [])
        XCTAssertEqual(client.head, 7)
        XCTAssertNil(client.snapshotRows)
        XCTAssertEqual(client.status, .idle)
    }

    func testARestartBetweenPagesResumesWithoutWipingAgain() async throws {
        let server = try BunServer(space: ["pageSize": 2])
        try await Self.other(server, Self.seven)
        do {
            let (client, pool) = try client(server)
            Relay.reset { index in
                if index == 2 { throw URLError(.networkConnectionLost) }
            }
            await client.sync()
            XCTAssertEqual(client.status, .offline)
            XCTAssertEqual(client.snapshotRows, 4)
            XCTAssertEqual(try meta(pool), [#"after={"id":"n4","table":"notes"}"#, "cursor=0", "snapshot_head=7"])
            XCTAssertEqual(try rows(pool), ["notes/n1:N1", "notes/n2:N2", "notes/n3:N3", "notes/n4:N4"])
            try pool.close()
        }
        Relay.reset()
        let (client, pool) = try client(server)
        try pool.sql("INSERT INTO notes (id, title) VALUES ('mine', 'MINE')")
        XCTAssertEqual(client.snapshotRows, 0)

        await client.sync()

        XCTAssertEqual(try Self.pages(), ["0 notes/n4 1", "0 tags/t1 0"])
        XCTAssertEqual(try rows(pool), ["notes/mine:MINE", "notes/n1:N1", "notes/n2:N2", "notes/n3:N3", "notes/n4:N4", "notes/n5:N5", "tags/t1:T1", "tags/t2:T2"])
        XCTAssertEqual(try meta(pool), ["cursor=7"])
        XCTAssertEqual(try pool.outbox(), [])
        XCTAssertNil(client.snapshotRows)
        XCTAssertEqual(client.status, .idle)
    }

    func testAWriteBetweenPagesArrivesWithTheNextDelta() async throws {
        let server = try BunServer(space: ["pageSize": 2])
        try await Self.other(server, Self.seven)
        let (client, pool) = try client(server)
        let url = server.url
        Relay.reset { index in
            guard index == 1 else { return }
            _ = try await BunServer.post(SyncRequest(protocol: 2, client: "other", cursor: 0, writes: [SyncWrite(seq: 8, table: "notes", id: "n1", op: .patch, values: ["title": .string("EDITED")])], after: nil), to: url)
        }

        await client.sync()

        XCTAssertEqual(try pool.strings("SELECT title FROM notes WHERE id = 'n1'"), ["N1"])
        XCTAssertEqual(try meta(pool), ["cursor=7"])
        XCTAssertEqual(client.head, 7)
        await client.sync()
        XCTAssertEqual(try Self.pages(), ["0 - 0", "0 notes/n2 0", "0 notes/n4 0", "0 tags/t1 0", "7 - 0"])
        XCTAssertEqual(try pool.strings("SELECT title FROM notes WHERE id = 'n1'"), ["EDITED"])
        XCTAssertEqual(try meta(pool), ["cursor=8"])
    }

    func testACursorBehindTheHorizonGetsASnapshot() async throws {
        let server = try BunServer(space: ["retention": 0, "compactEvery": 0])
        try await Self.other(server, [Self.put(1, "notes", "n1"), Self.put(2, "notes", "n2")])
        let (client, pool) = try client(server)
        await client.sync()
        XCTAssertEqual(try meta(pool), ["cursor=2"])
        try await Self.other(server, [SyncWrite(seq: 3, table: "notes", id: "n1", op: .delete, values: nil), Self.put(4, "notes", "n3")])
        try await Task.sleep(for: .milliseconds(10))
        try await Self.other(server)

        await client.sync()

        XCTAssertEqual(try Self.pages(), ["0 - 0", "2 - 0"])
        XCTAssertEqual(try rows(pool), ["notes/n2:N2", "notes/n3:N3"])
        XCTAssertEqual(try meta(pool), ["cursor=4"])
        XCTAssertEqual(client.status, .idle)
    }
}
