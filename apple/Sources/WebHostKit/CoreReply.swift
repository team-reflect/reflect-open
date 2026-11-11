public import Foundation

/// The result of one command: a JSON value, raw bytes, or a `{kind, message}` error as JSON.
public enum CoreReply: Sendable, Equatable {
  case json(Data)
  case bytes(Data)
  case error(Data)

  /// An error reply with the wire shape of the core's `AppError`.
  public static func error(kind: String, message: String) -> CoreReply {
    let json = try? JSONSerialization.data(withJSONObject: ["kind": kind, "message": message])
    return .error(json ?? Data(#"{"kind":"unknown","message":""}"#.utf8))
  }
}
