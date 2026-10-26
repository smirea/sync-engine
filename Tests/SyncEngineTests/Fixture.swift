import Foundation
import GRDB
import Synchronization
@testable import SyncEngine

/// The client tables and triggers are written out by hand as `docs/protocol.md` states them.
enum Fixture {
    static let schema = SyncSchema(
        tables: [
            SyncTable(name: "notes", columns: ["title", "body", "stars"]),
            SyncTable(name: "tags", columns: ["name", "weight", "color"]),
        ],
        statements: [
            "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, stars INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, weight REAL, color TEXT)",
            "ALTER TABLE tags ADD COLUMN color TEXT",
            "CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, \"table\" TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, col TEXT)",
            "CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value)",
        ] + triggers("notes", ["title", "body", "stars"]) + triggers("tags", ["name", "weight", "color"])
    )

    private static func triggers(_ t: String, _ columns: [String]) -> [String] {
        [
            """
            CREATE TRIGGER IF NOT EXISTS _ob_i_\(t) AFTER INSERT ON \(t)
              WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0
              BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('\(t)', NEW.id, 'insert', NULL); END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS _ob_d_\(t) AFTER DELETE ON \(t)
              WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0
              BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('\(t)', OLD.id, 'delete', NULL); END
            """,
        ] + columns.map { c in
            """
            CREATE TRIGGER IF NOT EXISTS _ob_u_\(t)_\(c) AFTER UPDATE OF \(c) ON \(t)
              WHEN coalesce((SELECT value FROM _meta WHERE key = 'applying'), 0) = 0 AND OLD.\(c) IS NOT NEW.\(c)
              BEGIN INSERT INTO _outbox ("table", id, op, col) VALUES ('\(t)', NEW.id, 'update', '\(c)'); END
            """
        }
    }

    static func pool() throws -> DatabasePool {
        try DatabasePool(path: FileManager.default.temporaryDirectory.appending(path: "sync-\(UUID().uuidString).sqlite").path)
    }

    static func migratedPool() throws -> (DatabasePool, SyncStore) {
        let pool = try pool()
        let store = SyncStore(schema: schema)
        try pool.write { try store.migrate($0) }
        return (pool, store)
    }

    static func note(_ id: String, title: String, body: String? = nil, stars: Int64 = 0) -> PulledRow {
        PulledRow(table: "notes", id: id, deleted: 0, values: ["id": .string(id), "title": .string(title), "body": body.map { .string($0) } ?? .null, "stars": .integer(stars)])
    }

    static func tombstone(_ table: String, _ id: String) -> PulledRow {
        PulledRow(table: table, id: id, deleted: 1, values: nil)
    }

    static func response(head: Int, acked: Int = 0, snapshot: Bool = false, rows: [PulledRow] = [], rejected: [RejectedWrite] = [], next: After? = nil) -> SyncResponse {
        SyncResponse(head: head, acked: acked, rejected: rejected, snapshot: snapshot, rows: rows, next: next)
    }
}

extension DatabasePool {
    func outbox() throws -> [OutboxRow] {
        try read { db in
            try Row.fetchAll(db, sql: "SELECT seq, \"table\", id, op, col FROM _outbox ORDER BY seq").map {
                OutboxRow(seq: $0["seq"], table: $0["table"], id: $0["id"], op: $0["op"], col: $0["col"])
            }
        }
    }

    func sql(_ sql: String) throws {
        try write { try $0.execute(sql: sql) }
    }

    func strings(_ sql: String) throws -> [String] {
        try read { try String.fetchAll($0, sql: sql) }
    }

    func int(_ sql: String) throws -> Int? {
        try read { try Int.fetchOne($0, sql: sql) }
    }
}

final class StubServer: URLProtocol {
    struct Received: Sendable {
        let url: URL
        let authorization: String?
        let body: Data
        let at = ContinuousClock.now
    }

    enum Reply: Sendable {
        case http(Int, Data)
        case failure(URLError.Code)
    }

    static let state = Mutex<(reply: Reply, received: [Received], latency: TimeInterval)>((.http(200, Data()), [], 0))

    static func reset(_ reply: Reply, latency: TimeInterval = 0) {
        state.withLock { $0 = (reply, [], latency) }
    }

    static func reply(_ reply: Reply) {
        state.withLock { $0.reply = reply }
    }

    static var received: [Received] { state.withLock { $0.received } }

    static func json(_ status: Int, _ value: some Encodable) -> Reply {
        .http(status, try! JSONEncoder().encode(value))
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubServer.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.scheme?.hasPrefix("http") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.streamedBody
        let received = Received(url: request.url!, authorization: request.value(forHTTPHeaderField: "Authorization"), body: body)
        let (reply, latency) = Self.state.withLock { state in
            state.received.append(received)
            return (state.reply, state.latency)
        }
        Thread.sleep(forTimeInterval: latency)
        switch reply {
        case let .http(status, data):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        case let .failure(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}
}

extension URLRequest {
    /// URLSession hands a protocol the body as a stream, never as `httpBody`.
    var streamedBody: Data {
        guard let stream = httpBodyStream else { return httpBody ?? Data() }
        var body = Data()
        stream.open()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { buffer.deallocate(); stream.close() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 4096)
            guard count > 0 else { break }
            body.append(buffer, count: count)
        }
        return body
    }
}

/// The real server from `Tests/server.ts` on a free port, with an in-memory space and the token `secret`.
final class BunServer {
    let url: URL
    private let process = Process()
    private let input = Pipe()

    init(space: [String: Int] = [:]) throws {
        let script = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "server.ts")
        let output = Pipe()
        process.executableURL = URL(filePath: "/usr/bin/env")
        process.arguments = ["bun", script.path, String(decoding: try JSONEncoder().encode(space), as: UTF8.self)]
        process.standardInput = input
        process.standardOutput = output
        try process.run()
        var line = Data()
        while !line.contains(UInt8(ascii: "\n")) {
            let chunk = output.fileHandleForReading.availableData
            guard !chunk.isEmpty else { throw URLError(.cannotConnectToHost) }
            line.append(chunk)
        }
        url = URL(string: "http://127.0.0.1:\(String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))/")!
    }

    deinit {
        process.terminate()
    }

    /// A sync from another device, straight to the server.
    static func post(_ body: SyncRequest, to url: URL) async throws -> SyncResponse {
        var request = URLRequest(url: url.appending(path: "sync"))
        request.httpMethod = "POST"
        request.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(SyncResponse.self, from: data)
    }
}

/// Forwards every request to the real server, recording its body and the reply and first awaiting `before` with its index, so a
/// test can write between two pages or fail one with a thrown `URLError`.
final class Relay: URLProtocol {
    typealias Before = @Sendable (Int) async throws -> Void

    static let state = Mutex<(bodies: [Data], replies: [Data], before: Before)>(([], [], { _ in }))

    static func reset(before: @escaping Before = { _ in }) {
        state.withLock { $0 = ([], [], before) }
    }

    static var requests: [SyncRequest] {
        get throws { try state.withLock { $0.bodies }.map { try JSONDecoder().decode(SyncRequest.self, from: $0) } }
    }

    static var responses: [SyncResponse] {
        get throws { try state.withLock { $0.replies }.map { try JSONDecoder().decode(SyncResponse.self, from: $0) } }
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Relay.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.scheme?.hasPrefix("http") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.streamedBody
        let forwarded = { var forwarded = request; forwarded.httpBody = body; return forwarded }()
        let (index, before) = Self.state.withLock { state in
            state.bodies.append(body)
            return (state.bodies.count - 1, state.before)
        }
        // URLProtocol is not Sendable, but URL loading takes its client callbacks from any thread.
        nonisolated(unsafe) let relay = self
        Task {
            do {
                try await before(index)
                let (data, response) = try await URLSession.shared.data(for: forwarded)
                Self.state.withLock { $0.replies.append(data) }
                relay.client?.urlProtocol(relay, didReceive: response, cacheStoragePolicy: .notAllowed)
                relay.client?.urlProtocol(relay, didLoad: data)
                relay.client?.urlProtocolDidFinishLoading(relay)
            } catch {
                relay.client?.urlProtocol(relay, didFailWithError: error)
            }
        }
    }

    override func stopLoading() {}
}
