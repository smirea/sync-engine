import Foundation

/// One synced table: its name and its columns besides `id`.
public struct SyncTable: Sendable {
    public let name: String
    public let columns: [String]

    public init(name: String, columns: [String]) {
        self.name = name
        self.columns = columns
    }
}

/// The client schema the generator writes into the app. `statements` is the complete client DDL in order: app
/// tables, `_outbox`, `_meta`, the capture triggers, and any `ALTER TABLE ... ADD COLUMN` the schema grew by.
public struct SyncSchema: Sendable {
    public let tables: [SyncTable]
    public let statements: [String]

    public init(tables: [SyncTable], statements: [String]) {
        self.tables = tables
        self.statements = statements
    }
}

public enum SyncStatus: Sendable, Equatable {
    case idle, syncing, offline, unauthorized, failed(String)
}

public struct SyncRejection: Sendable, Equatable {
    public let table: String
    public let id: String
    public let reason: String
}

/// A misuse the app must fix, never a runtime condition to retry.
public struct SyncSchemaError: Error, CustomStringConvertible {
    public let description: String
}
