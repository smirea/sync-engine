import Foundation
import GRDB

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
    func apply(_ response: SyncResponse, acked: Int? = nil, _ db: Database) throws {
        let acked = acked ?? response.acked
        try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('applying', 1)")
        if response.snapshot {
            for table in schema.tables {
                try db.execute(
                    sql: "DELETE FROM \"\(table.name)\" WHERE id NOT IN (SELECT id FROM _outbox WHERE \"table\" = ? AND seq > ?)",
                    arguments: [table.name, acked]
                )
            }
        }
        for row in response.rows {
            guard let known = tables[row.table] else { continue }
            let pending = try Bool.fetchOne(
                db, sql: "SELECT EXISTS (SELECT 1 FROM _outbox WHERE \"table\" = ? AND id = ? AND seq > ?)",
                arguments: [row.table, row.id, acked]
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
            let update = columns.isEmpty ? "NOTHING" : "UPDATE SET " + columns.map { "\"\($0)\" = excluded.\"\($0)\"" }.joined(separator: ", ")
            let arguments: [DatabaseValueConvertible?] = [row.id] + columns.map { values[$0]!.databaseValue }
            try db.execute(
                sql: "INSERT INTO \"\(row.table)\" (\(names)) VALUES (\(marks)) ON CONFLICT (id) DO \(update)",
                arguments: StatementArguments(arguments)
            )
        }
        try db.execute(sql: "DELETE FROM _outbox WHERE seq <= ?", arguments: [acked])
        try db.execute(sql: "INSERT OR REPLACE INTO _meta (key, value) VALUES ('cursor', ?), ('applying', 0)", arguments: [response.head])
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
