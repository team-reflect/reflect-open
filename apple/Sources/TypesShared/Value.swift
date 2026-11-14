/// Any JSON value: the Swift side of Rust's `serde_json::Value`.
///
/// TODO: specta-swift renders `serde_json::Value` as an enum that does not
/// compile (`case null(Void)`, an undefined `Number`), so `pnpm gen:types`
/// drops it and this file defines it. Remove this file once specta-swift
/// renders it correctly; this needs an upstream pull request.
public enum Value: Codable, Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([Value])
  case object([String: Value])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([Value].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: Value].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}
