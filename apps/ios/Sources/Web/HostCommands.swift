import Foundation
import TypesShared
import WebHostKit
import os

/// The `host.` commands: services of the shell itself.
@MainActor
enum HostCommands {
  private static let webLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "app.reflect.ios", category: "web")
  /// Keeps the file writes of `host.log` in order and off the main thread.
  private static let logQueue = DispatchQueue(label: "app.reflect.host-log", qos: .utility)

  /// `openURL` hands a URL to the system and returns whether an app opened it.
  static func all(openURL: @escaping @MainActor (URL) async -> Bool) -> [ShellCommandName:
    ShellCommand]
  {
    [
      .hostLog: log,
      .hostOpenUrl: { request in await open(request, with: openURL) },
    ]
  }

  /// `host.log {level, message}`: writes a line of the web app to the system
  /// log and to the core's log file.
  private static func log(_ request: ShellRequest) async -> CoreReply {
    guard let args = request.decodeArgs(HostLogArgs.self) else {
      return .error(.parse(.init(message: "host.log takes {level, message}")))
    }
    switch args.level {
    case .error: webLogger.error("\(args.message, privacy: .public)")
    case .warn: webLogger.warning("\(args.message, privacy: .public)")
    case .info: webLogger.info("\(args.message, privacy: .public)")
    }
    logQueue.async {
      ReflectCore.log(args.level, args.message)
    }
    return .null
  }

  /// `host.open_url {url}`: opens a URL with the system handler.
  private static func open(
    _ request: ShellRequest, with openURL: @MainActor (URL) async -> Bool
  ) async -> CoreReply {
    guard let args = request.decodeArgs(HostOpenUrlArgs.self),
      let url = URL(string: args.url), url.scheme != nil
    else {
      return .error(.parse(.init(message: "host.open_url takes {url} with an absolute URL")))
    }
    guard await openURL(url) else {
      return .error(.io(.init(message: "no app opens \(args.url)")))
    }
    return .null
  }
}
