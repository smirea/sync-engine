import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case integer(Int64)
    case double(Double)
    case null

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let integer = try? container.decode(Int64.self) {
            self = .integer(integer)
        } else if let double = try? container.decode(Double.self) {
            self = .double(double)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(text): try container.encode(text)
        case let .integer(integer): try container.encode(integer)
        case let .double(double): try container.encode(double)
        case .null: try container.encodeNil()
        }
    }
}

struct SyncWrite: Codable, Equatable, Sendable {
    enum Op: String, Codable, Sendable { case put, patch, delete }

    let seq: Int
    let table: String
    let id: String
    let op: Op
    let values: [String: JSONValue]?
}

struct SyncRequest: Codable, Sendable {
    let `protocol`: Int
    let client: String
    let cursor: Int
    let writes: [SyncWrite]
}

struct RejectedWrite: Codable, Equatable, Sendable {
    let seq: Int
    let table: String
    let id: String
    let reason: String
}

struct PulledRow: Codable, Equatable, Sendable {
    let table: String
    let id: String
    let deleted: Int
    let values: [String: JSONValue]?
}

struct SyncResponse: Codable, Equatable, Sendable {
    let head: Int
    let acked: Int
    let rejected: [RejectedWrite]
    let snapshot: Bool
    let rows: [PulledRow]
}

struct LiveMessage: Codable, Sendable {
    let head: Int
}

struct OutboxRow: Equatable, Sendable {
    let seq: Int
    let table: String
    let id: String
    let op: String
    let col: String?
}
