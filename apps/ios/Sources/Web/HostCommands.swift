import Foundation
import os

/// The `host.` commands: services of the shell itself.
@MainActor
enum HostCommands {
  private static let webLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "app.reflect.ios", category: "web")

  static func all() -> [String: ShellCommand] {
    [
      "host.log": log,
      "host.deep_link_pending": { _ in .json(Data("null".utf8)) },
    ]
  }

  /// `host.log {level, message}`: writes a line of the web app to the system log.
  private static func log(_ request: ShellRequest) async -> CoreReply {
    struct Args: Decodable {
      var level: String
      var message: String
    }
    guard let args = try? JSONDecoder().decode(Args.self, from: request.args) else {
      return .error(kind: "parse", message: "host.log takes {level, message}")
    }
    switch args.level {
    case "error": webLogger.error("\(args.message, privacy: .public)")
    case "warn": webLogger.warning("\(args.message, privacy: .public)")
    default: webLogger.info("\(args.message, privacy: .public)")
    }
    return .json(Data("null".utf8))
  }
}
