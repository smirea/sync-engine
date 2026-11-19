import Foundation
import GRDB

/// The page to request next and the head of the snapshot's first page, which becomes the cursor once it ends.
struct SnapshotProgress: Equatable, Sendable {
    let after: After
    let head: Int
}

/// The outbox coalesced into writes. `highest` is the largest outbox seq read, sent or dropped, so the client can
/// clear dropped groups along with the acked rows.
struct Collected: Sendable {
    let writes: [SyncWrite]
    let highest: Int

    var sent: Int { writes.map(\.seq).max() ?? 0 }
}

/// Each method runs inside the transaction its caller opened.
struct SyncStore: Sendable {
    let schema: SyncSchema
    private let tables: [String: SyncTable]

    init(schema: SyncSchema) {
        self.schema = schema
        tables = Dictionary(uniqueKeysWithValues: schema.tables.map { ($0.name, $0) })
    }

    /// The generator emits the `ALTER TABLE` for a grown schema; the client only makes rerunning it harmless.
    func migrate(_ db: Database) throws {
        let tracked = try !columns(of: "_seen", db).isEmpty
        let grown = try schema.tables.filter { !Set(["id"] + $0.columns).isSubset(of: try columns(of: $0.name, db)) }.map(\.name)
        let addColumn = /^\s*ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+COLUMN\s+"?(\w+)"?/.ignoresCase()
        for statement in schema.statements {
            if let match = statement.firstMatch(of: addColumn),
               try columns(of: String(match.1), db).contains(String(match.2)) {
                continue
            }
            try db.execute(sql: statement)
        }
        for table in schema.tables {
            let present = try columns(of: table.name, db)
            if let missing = (["id"] + table.columns).first(where: { !present.contains($0) }) {
                throw SyncSchemaError(description: "\(table.name).\(missing) is in the schema but not in the database; the DDL must add it")
            }
        }
        // The store's own table, which no generated statement names: an app pins the generator and this package
        // separately, so DDL the generator had to emit could be missing under a newer store.
        try db.execute(sql: "CREATE TABLE IF NOT EXISTS _seen (\"table\" TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (\"table\", id)) WITHOUT ROWID")
        try db.execute(sql: "INSERT OR IGNORE INTO _meta (key, value) VALUES ('client', ?), ('cursor', 0)", arguments: [UUID().uuidString.lowercased()])
        let paging = try snapshot(db) != nil
        // A snapshot begun before `_seen` existed emptied the tables on its first page and recorded none of the rows that
        // followed, so its last page would take them for rows the server lacks.
        guard !grown.isEmpty || (!tracked && paging) else { return }
        // Rows pulled before a table or a column existed were stored without it, and a delta resends a row only when it
        // changes, so the grown tables are pulled whole again. A cursor that gets a full snapshot anyway, or one in
        // progress whose earlier pages predate the growth, starts that snapshot over instead.
        if try cursor(db) == 0 || paging {
            try db.execute(sql: "UPDATE _meta SET value = 0 WHERE key = 'cursor'")
            try db.execute(sql: "DELETE FROM _meta WHERE key IN ('after', 'snapshot_head', 'refresh')")
        } else {
            let pending = try refresh(db)?.tables ?? []
            try setRefresh(Refresh(tables: pending + grown.filter { !pending.contains($0) }), db)
        }
    }

    /// Empties every app table and the outbox, with `applying` set so nothing is captured, then mints a new client id at
    /// cursor 0.
    func reset(_ db: Database) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 1)")
        for table in schema.tables { try db.execute(sql: "DELETE FROM \(table.name)") }
        try db.execute(sql: "DELETE FROM _outbox")
        try db.execute(sql: "DELETE FROM _seen")
        try db.execute(sql: "DELETE FROM _meta")
        try db.execute(sql: "INSERT OR IGNORE INTO _meta (key, value) VALUES ('client', ?), ('cursor', 0)", arguments: [UUID().uuidString.lowercased()])
    }

    private func columns(of table: String, _ db: Database) throws -> Set<String> {
        Set(try String.fetchAll(db, sql: "SELECT name FROM pragma_table_info(?)", arguments: [table]))
    }

    func meta(_ key: String, _ db: Database) throws -> String? {
        try String.fetchOne(db, sql: "SELECT value FROM _meta WHERE key = ?", arguments: [key])
    }

    func cursor(_ db: Database) throws -> Int {
        try Int.fetchOne(db, sql: "SELECT value FROM _meta WHERE key = 'cursor'") ?? 0
    }

    /// A paged snapshot in progress, else nil: `after` and `snapshot_head` in `_meta` are written and cleared together.
    func snapshot(_ db: Database) throws -> SnapshotProgress? {
        guard let after = try meta("after", db) else { return nil }
        let head = try Int.fetchOne(db, sql: "SELECT value FROM _meta WHERE key = 'snapshot_head'") ?? 0
        return SnapshotProgress(after: try JSONDecoder().decode(After.self, from: Data(after.utf8)), head: head)
    }

    /// The tables the schema grew that are still to be pulled whole, else nil.
    func refresh(_ db: Database) throws -> Refresh? {
        try meta("refresh", db).map { try JSONDecoder().decode(Refresh.self, from: Data($0.utf8)) }
    }

    private func setRefresh(_ refresh: Refresh, _ db: Database) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('refresh', ?)", arguments: [try Self.json(refresh)])
    }

    private static func json(_ value: some Encodable) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    /// The next request: the cursor and space, plus the page of a snapshot in progress or the tables to refresh.
    func request(client: String, writes: [SyncWrite], _ db: Database) throws -> SyncRequest {
        let progress = try snapshot(db)
        return SyncRequest(
            protocol: 2, client: client, cursor: try cursor(db), writes: writes, after: progress?.after,
            space: try meta("space", db) ?? "", refresh: progress == nil ? try refresh(db) : nil
        )
    }

    func collect(_ db: Database) throws -> Collected {
        let rows = try Row.fetchAll(db, sql: "SELECT seq, \"table\", id, op, col FROM _outbox ORDER BY seq").map {
            OutboxRow(seq: $0["seq"], table: $0["table"], id: $0["id"], op: $0["op"], col: $0["col"])
        }
        var order: [String] = []
        var groups: [String: [OutboxRow]] = [:]
        for row in rows {
            let key = "\(row.table)\u{0}\(row.id)"
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(row)
        }
        let writes = try order.compactMap { key -> SyncWrite? in
            let group = groups[key]!
            let (table, id, seq) = (group[0].table, group[0].id, group.last!.seq)
            if group.last!.op == "delete" {
                return SyncWrite(seq: seq, table: table, id: id, op: .delete, values: nil)
            }
            guard let current = try currentRow(table, id: id, db) else { return nil }
            if group.contains(where: { $0.op == "insert" }) {
                return SyncWrite(seq: seq, table: table, id: id, op: .put, values: current)
            }
            let patched = Set(group.compactMap(\.col))
            return SyncWrite(seq: seq, table: table, id: id, op: .patch, values: current.filter { patched.contains($0.key) })
        }
        return Collected(writes: writes, highest: rows.last?.seq ?? 0)
    }

    private func currentRow(_ table: String, id: String, _ db: Database) throws -> [String: JSONValue]? {
        guard let known = tables[table] else { throw SyncSchemaError(description: "\(table) is in the outbox but not in the schema") }
        guard let row = try Row.fetchOne(db, sql: "SELECT * FROM \"\(table)\" WHERE id = ?", arguments: [id]) else { return nil }
        var values: [String: JSONValue] = [:]
        for column in known.columns where column != "id" {
            let stored: DatabaseValue = row[column]
            values[column] = switch stored.storage {
            case .null: .null
            case let .int64(integer): .integer(integer)
            case let .double(double): .double(double)
            case let .string(text): .string(text)
            case .blob: throw SyncSchemaError(description: "\(table).\(column) holds a blob; sync carries text, integer and real only")
            }
        }
        return values
    }

    /// `acked` defaults to the response's; the client raises it to `Collected.highest` so dropped groups clear too.
    /// Answers whether the sync needs another request before it is done.
    @discardableResult
    func apply(_ response: SyncResponse, acked: Int? = nil, _ db: Database) throws -> Bool {
        let acked = acked ?? response.acked
        try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 1)")
        // The server answers another space's cursor with a full snapshot from its first page, so pages fetched before and
        // a refresh under way belong to the old space.
        if let space = response.space, space != (try meta("space", db) ?? "") {
            try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('space', ?)", arguments: [space])
            try db.execute(sql: "DELETE FROM _meta WHERE key IN ('after', 'snapshot_head', 'refresh')")
        }
        let progress = try snapshot(db)
        let refreshing = try refresh(db)
        let scoped = response.snapshot && response.tables != nil
        let full = response.snapshot && !scoped
        // A full snapshot holds the refreshed tables too.
        if full, refreshing != nil { try db.execute(sql: "DELETE FROM _meta WHERE key = 'refresh'") }
        let first = (full && progress == nil) || (scoped && refreshing?.after == nil)
        if first { try db.execute(sql: "DELETE FROM _seen") }
        if response.snapshot, !first {
            // A write acked with a later page landed after the cursor this snapshot ends on, so the next delta says what
            // became of its row, and its page may already have gone by: the snapshot's silence is no verdict. A write
            // acked with the first page landed before any page was read, so the snapshot itself is the verdict.
            try db.execute(sql: "INSERT OR IGNORE INTO _seen (\"table\", id) SELECT \"table\", id FROM _outbox WHERE seq <= ?", arguments: [acked])
        }
        try db.execute(sql: "DELETE FROM _outbox WHERE seq <= ?", arguments: [acked])
        for row in response.rows {
            guard let known = tables[row.table] else { continue }
            let pending = try Bool.fetchOne(
                db, sql: "SELECT EXISTS (SELECT 1 FROM _outbox WHERE \"table\" = ? AND id = ?)", arguments: [row.table, row.id]
            )!
            if pending { continue }
            if row.deleted != 0 {
                try db.execute(sql: "DELETE FROM \"\(row.table)\" WHERE id = ?", arguments: [row.id])
                continue
            }
            guard let values = row.values else { throw SyncSchemaError(description: "\(row.table) \(row.id): a live row without values") }
            let columns = known.columns.filter { values[$0] != nil }
            let names = (["id"] + columns).map { "\"\($0)\"" }.joined(separator: ", ")
            let marks = Array(repeating: "?", count: columns.count + 1).joined(separator: ", ")
            let quoted = columns.map { "\"\($0)\"" }
            let excluded = quoted.map { "excluded.\($0)" }
            // An unchanged row is not rewritten, so the update hook and every GRDB observation of the table stay quiet.
            let update = columns.isEmpty ? "NOTHING" : "UPDATE SET " + zip(quoted, excluded).map { "\($0) = \($1)" }.joined(separator: ", ")
                + " WHERE (\(quoted.joined(separator: ", "))) IS NOT (\(excluded.joined(separator: ", ")))"
            let arguments: [DatabaseValueConvertible?] = [row.id] + columns.map { values[$0]!.databaseValue }
            try db.execute(
                sql: "INSERT INTO \"\(row.table)\" (\(names)) VALUES (\(marks)) ON CONFLICT (id) DO \(update)",
                arguments: StatementArguments(arguments)
            )
            if response.snapshot {
                try db.execute(sql: "INSERT OR IGNORE INTO _seen (\"table\", id) VALUES (?, ?)", arguments: [row.table, row.id])
            }
        }
        if response.snapshot, response.next == nil {
            // The snapshot is whole: what it did not hold is gone from the server. Rows are never emptied first, so a
            // snapshot of an unchanged space writes to no app table.
            for table in schema.tables where response.tables?.contains(table.name) ?? true {
                try db.execute(
                    sql: """
                    DELETE FROM "\(table.name)" WHERE id NOT IN (SELECT id FROM _seen WHERE "table" = ?)
                    AND id NOT IN (SELECT id FROM _outbox WHERE "table" = ?)
                    """,
                    arguments: [table.name, table.name]
                )
            }
            try db.execute(sql: "DELETE FROM _seen")
        }
        let more: Bool
        if let pulled = response.tables, scoped {
            // The cursor stays: the delta from it follows the last page and brings what changed while paging.
            if let next = response.next {
                try setRefresh(Refresh(tables: refreshing?.tables ?? pulled, after: next), db)
            } else {
                try db.execute(sql: "DELETE FROM _meta WHERE key = 'refresh'")
            }
            more = true
        } else if let next = response.next {
            try db.execute(
                sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('after', ?), ('snapshot_head', ?)",
                arguments: [try Self.json(next), progress?.head ?? response.head]
            )
            more = true
        } else if !full, refreshing != nil {
            // A delta answered a refresh: the server is older than refresh and dropped it. A full snapshot is the only
            // other way to the rows stored before the tables grew.
            try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('cursor', 0)")
            try db.execute(sql: "DELETE FROM _meta WHERE key = 'refresh'")
            more = true
        } else {
            // The first page's head: rows that changed while later pages were fetched come with the next delta.
            try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('cursor', ?)", arguments: [progress?.head ?? response.head])
            try db.execute(sql: "DELETE FROM _meta WHERE key IN ('after', 'snapshot_head')")
            more = false
        }
        try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 0)")
        return more
    }
}

extension JSONValue {
    var databaseValue: DatabaseValue {
        switch self {
        case let .string(text): text.databaseValue
        case let .integer(integer): integer.databaseValue
        case let .double(double): double.databaseValue
        case .null: .null
        }
    }
}
