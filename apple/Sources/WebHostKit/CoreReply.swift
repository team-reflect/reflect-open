public import Foundation
public import TypesShared

/// The result of one command: a JSON value, raw bytes, or a `{kind, message}` error as JSON.
public enum CoreReply: Sendable, Equatable {
  case json(Data)
  case bytes(Data)
  case error(Data)

  /// An error reply of the core's `AppError` contract.
  public static func error(_ error: AppError) -> CoreReply {
    let json = try? JSONEncoder().encode(error)
    return .error(json ?? Data(#"{"kind":"unknown","message":""}"#.utf8))
  }

  /// The JSON reply `null`: the answer of a command that returns nothing.
  public static let null = CoreReply.json(Data("null".utf8))

  /// A JSON reply that encodes `value`.
  public static func value(_ value: some Encodable) -> CoreReply {
    guard let json = try? JSONEncoder().encode(value) else {
      return .error(.unknown(.init(message: "the shell could not encode a reply")))
    }
    return .json(json)
  }
}
