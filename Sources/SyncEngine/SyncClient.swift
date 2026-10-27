import Foundation
import GRDB
import Network
import Observation
import os
#if os(iOS)
import UIKit
#endif

@MainActor @Observable
public final class SyncClient {
    public private(set) var status: SyncStatus = .idle
    /// Outbox rows not yet acked by the server.
    public private(set) var pending = 0
    public private(set) var lastSyncAt: Date?
    public private(set) var head = 0
    /// What the server refused, newest first, at most 20. A rejected write is dropped, so this is the only trace of it.
    public private(set) var rejected: [SyncRejection] = []
    /// Rows this run has applied of a paged snapshot in progress, else nil. A snapshot interrupted by a restart
    /// reads 0 until its next page lands.
    public private(set) var snapshotRows: Int?

    @ObservationIgnored private let database: DatabasePool
    @ObservationIgnored private let store: SyncStore
    @ObservationIgnored private let endpoint: URL
    @ObservationIgnored private let token: @Sendable () -> String?
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let headers: [String: String]
    @ObservationIgnored private let beforePush: (@Sendable () async throws -> Void)?
    @ObservationIgnored private let log = Logger(subsystem: "sync-engine", category: "client")
    @ObservationIgnored private var clientID = ""
    @ObservationIgnored private var outbox: AnyDatabaseCancellable?
    @ObservationIgnored private var highestOutboxSeq = 0
    @ObservationIgnored private var liveHead = 0
    @ObservationIgnored private var running = false
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var authorized = true
    @ObservationIgnored private var online = true
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var chain: Task<Void, Never>?
    @ObservationIgnored private var scheduled: Task<Void, Never>?
    @ObservationIgnored private var due: ContinuousClock.Instant?
    @ObservationIgnored private var live: Task<Void, Never>?
    @ObservationIgnored private var periodic: Task<Void, Never>?
    @ObservationIgnored private var triggers: [Task<Void, Never>] = []
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var monitor: NWPathMonitor?

    /// `headers` go on every sync request, such as the app's own client header. `beforePush` runs before a sync that
    /// sends writes, such as to upload files the rows name, so a reader never sees a row before what it points at; a
    /// throw fails the sync, which retries like any other failure, and the writes wait.
    public init(
        database: DatabasePool,
        schema: SyncSchema,
        endpoint: URL,
        token: @escaping @Sendable () -> String?,
        session: URLSession = .shared,
        headers: [String: String] = [:],
        beforePush: (@Sendable () async throws -> Void)? = nil
    ) {
        self.database = database
        store = SyncStore(schema: schema)
        self.endpoint = endpoint
        self.token = token
        self.session = session
        self.headers = headers
        self.beforePush = beforePush
    }

    isolated deinit {
        stop()
    }

    private struct Outbox: Equatable, Sendable {
        let count: Int
        let top: Int
    }

    public func migrate() throws {
        let store = store
        let (client, cursor, paging) = try database.write { db in
            try store.migrate(db)
            return (try store.meta("client", db) ?? "", try store.cursor(db), try store.snapshot(db) != nil)
        }
        clientID = client
        head = cursor
        snapshotRows = paging ? 0 : nil
        guard outbox == nil else { return }
        outbox = ValueObservation
            .tracking { db in
                let row = try Row.fetchOne(db, sql: "SELECT count(*) AS count, coalesce(max(seq), 0) AS top FROM _outbox")!
                return Outbox(count: row["count"], top: row["top"])
            }
            .removeDuplicates()
            .start(in: database, scheduling: .immediate) { [log] error in
                log.error("Outbox observation failed: \(String(describing: error))")
            } onChange: { [weak self] outbox in
                guard let self else { return }
                pending = outbox.count
                if outbox.top > highestOutboxSeq {
                    highestOutboxSeq = outbox.top
                    localWrite()
                }
            }
    }

    /// One `POST /sync`. Calls run one after another; a call made during a sync runs after it. This is also the only
    /// call that tries a token again after a 401.
    public func sync() async {
        precondition(outbox != nil, "call migrate() before sync()")
        authorized = true
        reconcileLoops()
        await enqueue()
    }

    public func start() {
        precondition(outbox != nil, "call migrate() before start()")
        guard !running else { return }
        running = true
        reconcileLoops()
        startTriggers()
        schedule(after: .zero)
    }

    /// Waits for a sync in flight, then empties every app table and the outbox and starts over under a new client id at
    /// cursor 0, as a fresh database would: for an app that signs another user in on the same device. Call it stopped.
    public func reset() async throws {
        await chain?.value
        let store = store
        let client = try await database.write { db in
            try store.reset(db)
            return try store.meta("client", db) ?? ""
        }
        clientID = client
        head = 0
        liveHead = 0
        rejected = []
        snapshotRows = nil
        status = .idle
    }

    public func stop() {
        running = false
        reconcileLoops()
        scheduled?.cancel()
        scheduled = nil
        due = nil
        for trigger in triggers { trigger.cancel() }
        triggers = []
        monitor?.cancel()
        monitor = nil
    }

    private func enqueue() async {
        let previous = chain
        let task = Task { [weak self] in
            await previous?.value
            await self?.performSync()
        }
        chain = task
        await task.value
    }

    private func performSync() async {
        guard let token = token() else {
            unauthorized()
            return
        }
        status = .syncing
        do {
            let store = store
            var collected = try await database.read { try store.collect($0) }
            if !collected.writes.isEmpty, let beforePush { try await beforePush() }
            while true {
                let (cursor, progress) = try await database.read { db in (try store.cursor(db), try store.snapshot(db)) }
                let request = SyncRequest(protocol: 2, client: clientID, cursor: cursor, writes: collected.writes, after: progress?.after)
                let response = try await post(request, token: token)
                if !collected.writes.isEmpty, response.acked > collected.sent {
                    try await adoptNewClientID(acked: response.acked, sent: collected.sent)
                    return
                }
                let acked = response.acked >= collected.sent ? max(response.acked, collected.highest) : response.acked
                let (applied, paging) = try await database.write { db in
                    try store.apply(response, acked: acked, db)
                    return (try store.cursor(db), try store.snapshot(db) != nil)
                }
                let refused = response.rejected.map { SyncRejection(table: $0.table, id: $0.id, reason: $0.reason) }
                if !refused.isEmpty { rejected = Array((refused + rejected).prefix(20)) }
                if paging {
                    snapshotRows = (snapshotRows ?? 0) + response.rows.count
                    collected = Collected(writes: [], highest: 0)
                    continue
                }
                snapshotRows = nil
                head = applied
                break
            }
            lastSyncAt = .now
            failures = 0
            status = .idle
            if liveHead > head { schedule(after: .zero) }
        } catch is URLError {
            status = .offline
            retryLater()
        } catch Refusal.unauthorized {
            unauthorized()
        } catch let Refusal.status(code) {
            fail("HTTP \(code)")
        } catch let error as SyncSchemaError {
            log.fault("Sync stopped on a schema misuse: \(error.description)")
            status = .failed(error.description)
            assertionFailure(error.description)
        } catch {
            fail(String(describing: error))
        }
    }

    private enum Refusal: Error {
        case unauthorized
        case status(Int)
    }

    private func post(_ body: SyncRequest, token: String) async throws -> SyncResponse {
        var request = URLRequest(url: endpoint.appending(path: "sync"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200: return try JSONDecoder().decode(SyncResponse.self, from: data)
        case 401: throw Refusal.unauthorized
        case let code: throw Refusal.status(code)
        }
    }

    /// An ack above the largest seq sent means the server knows this client id with a higher sequence: the database
    /// is a restored backup or a copy. The response is discarded and the outbox re-sent under a fresh id.
    private func adoptNewClientID(acked: Int, sent: Int) async throws {
        let fresh = UUID().uuidString.lowercased()
        try await database.write { db in try db.execute(sql: "UPDATE _meta SET value = ? WHERE key = 'client'", arguments: [fresh]) }
        log.notice("acked \(acked) is above the largest seq sent \(sent); continuing as client \(fresh)")
        clientID = fresh
        status = .idle
        schedule(after: .zero)
    }

    private func unauthorized() {
        status = .unauthorized
        authorized = false
        reconcileLoops()
    }

    private func fail(_ reason: String) {
        log.error("Sync failed: \(reason)")
        status = .failed(reason)
        retryLater()
    }

    private func retryLater() {
        failures += 1
        schedule(after: .seconds(min(15, 1 << min(failures, 6))))
    }

    /// Writes within 100 ms of the first share its sync; a write during a long backoff pulls the sync forward.
    private func localWrite() {
        if let due, due <= .now + .milliseconds(100) { return }
        schedule(after: .milliseconds(100))
    }

    private func schedule(after delay: Duration) {
        guard running, authorized else { return }
        scheduled?.cancel()
        due = .now + delay
        scheduled = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            due = nil
            await enqueue()
        }
    }

    /// A refused token is tried again only by the public `sync()`, never by a retry, a local write or a trigger.
    private var wantsLoops: Bool { running && foreground && authorized }

    private func reconcileLoops() {
        if wantsLoops, live == nil {
            live = liveLoop()
            periodic = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled, let self else { return }
                    await enqueue()
                }
            }
        } else if !wantsLoops {
            haltLoops()
        }
    }

    private func haltLoops() {
        live?.cancel()
        live = nil
        periodic?.cancel()
        periodic = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func reconnect() {
        haltLoops()
        reconcileLoops()
    }

    private func liveLoop() -> Task<Void, Never> {
        let onOpen: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in self?.schedule(after: .zero) }
        }
        let onHead: @Sendable (Int) -> Void = { [weak self] head in
            Task { @MainActor in self?.received(head: head) }
        }
        return Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                guard let socket = self?.openSocket() else { return }
                let connected = await Self.listen(to: socket, onOpen: onOpen, onHead: onHead)
                do {
                    guard let self else { return }
                    if (socket.response as? HTTPURLResponse)?.statusCode == 401 {
                        unauthorized()
                        return
                    }
                    self.socket = nil
                }
                guard !Task.isCancelled else { return }
                attempt = connected ? 1 : attempt + 1
                try? await Task.sleep(for: .seconds(min(15, 1 << min(attempt, 6))))
                guard !Task.isCancelled, let self else { return }
                // HTTP often answers while the socket still fails after an outage (-1009), so an attempt pulls
                // unless a retry or a write is about to.
                if due == nil { schedule(after: .zero) }
            }
        }
    }

    private func openSocket() -> URLSessionWebSocketTask {
        var components = URLComponents(url: endpoint.appending(path: "live"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        var request = URLRequest(url: components.url!)
        if let token = token() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let task = session.webSocketTask(with: request)
        socket = task
        task.resume()
        return task
    }

    /// Receives until the socket fails. Pings keep NAT and proxy idle timeouts from dropping it, and the first pong
    /// or message counts as connected so the backoff resets and a sync covers nudges missed while disconnected.
    /// Holds no reference to the client.
    private nonisolated static func listen(to socket: URLSessionWebSocketTask, onOpen: @escaping @Sendable () -> Void, onHead: @escaping @Sendable (Int) -> Void) async -> Bool {
        var connected = false
        let pinger = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                try? await socket.ping()
            }
        }
        defer { pinger.cancel() }
        do {
            try await socket.ping()
            connected = true
            onOpen()
            while true {
                let data = switch try await socket.receive() {
                case let .string(text): Data(text.utf8)
                case let .data(data): data
                @unknown default: Data()
                }
                connected = true
                if let message = try? JSONDecoder().decode(LiveMessage.self, from: data) { onHead(message.head) }
            }
        } catch {
            return connected
        }
    }

    /// The server tells the writer too, usually before its own response is applied, so a head seen during a sync is
    /// checked again after that sync instead of pulled at once.
    private func received(head: Int) {
        liveHead = max(liveHead, head)
        if status != .syncing, liveHead > self.head { schedule(after: .zero) }
    }

    private func startTriggers() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(satisfied: satisfied) }
        }
        monitor.start(queue: .main)
        self.monitor = monitor
        #if os(iOS)
        triggers = [
            Task { [weak self] in
                for await _ in NotificationCenter.default.notifications(named: UIApplication.willEnterForegroundNotification).map({ _ in true }) {
                    guard let self else { return }
                    await enteredForeground()
                }
            },
            Task { [weak self] in
                for await _ in NotificationCenter.default.notifications(named: UIApplication.didEnterBackgroundNotification).map({ _ in true }) {
                    guard let self else { return }
                    foreground = false
                    reconcileLoops()
                    let assertion = UIApplication.shared.beginBackgroundTask()
                    await enqueue()
                    UIApplication.shared.endBackgroundTask(assertion)
                }
            },
        ]
        #endif
    }

    func enteredForeground() async {
        foreground = true
        failures = 0
        reconnect()
        await enqueue()
    }

    private func pathChanged(satisfied: Bool) {
        defer { online = satisfied }
        guard satisfied, !online else { return }
        failures = 0
        reconnect()
        schedule(after: .zero)
    }
}

extension URLSessionWebSocketTask {
    func ping() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            sendPing { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
}
