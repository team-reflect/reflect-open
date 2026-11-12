public import Foundation

/// The request of a command that the shell answers itself.
public struct ShellRequest: Sendable {
  /// The JSON object of camelCase arguments; empty for a binary request.
  public var args: Data
  /// The request headers under lowercase names.
  public var headers: [String: String]
  /// The raw body of a binary request; empty otherwise.
  public var body: Data

  public init(args: Data, headers: [String: String], body: Data) {
    self.args = args
    self.headers = headers
    self.body = body
  }

  /// The arguments decoded as `T`, or nil when they do not match it.
  public func decodeArgs<T: Decodable>(_ type: T.Type) -> T? {
    try? JSONDecoder().decode(type, from: args)
  }
}

/// A command that the shell answers itself: a `host.` command or a
/// `plugin:<name>|<command>` capability.
public typealias ShellCommand = @MainActor (ShellRequest) async -> CoreReply
