import Foundation
import os

/// The `host.` commands: services of the shell itself.
@MainActor
enum HostCommands {
  private static let webLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "app.reflect.ios", category: "web")
  private static let null = CoreReply.json(Data("null".utf8))
  /// Keeps the file writes of `host.log` in order and off the main thread.
  private static let logQueue = DispatchQueue(label: "app.reflect.host-log", qos: .utility)

  /// `openURL` hands a URL to the system and returns whether an app opened it.
  static func all(deepLinks: DeepLinks, openURL: @escaping @MainActor (URL) async -> Bool)
    -> [String: ShellCommand]
  {
    [
      "host.log": log,
      "host.open_url": { request in await open(request, with: openURL) },
      "host.deep_link_pending": { _ in
        guard let urls = deepLinks.takePending(),
          let json = try? JSONSerialization.data(withJSONObject: urls)
        else { return null }
        return .json(json)
      },
    ]
  }

  /// `host.log {level, message}`: writes a line of the web app to the system
  /// log and to the core's log file.
  private static func log(_ request: ShellRequest) async -> CoreReply {
    struct Args: Decodable {
      var level: String
      var message: String
    }
    guard let args = try? JSONDecoder().decode(Args.self, from: request.args) else {
      return .error(kind: "parse", message: "host.log takes {level, message}")
    }
    let level: ReflectCore.LogLevel
    switch args.level {
    case "error":
      webLogger.error("\(args.message, privacy: .public)")
      level = .error
    case "warn":
      webLogger.warning("\(args.message, privacy: .public)")
      level = .warn
    default:
      webLogger.info("\(args.message, privacy: .public)")
      level = .info
    }
    logQueue.async {
      ReflectCore.log(level, args.message)
    }
    return null
  }

  /// `host.open_url {url}`: opens a URL with the system handler.
  private static func open(
    _ request: ShellRequest, with openURL: @MainActor (URL) async -> Bool
  ) async -> CoreReply {
    struct Args: Decodable {
      var url: String
    }
    guard let args = try? JSONDecoder().decode(Args.self, from: request.args),
      let url = URL(string: args.url), url.scheme != nil
    else {
      return .error(kind: "parse", message: "host.open_url takes {url} with an absolute URL")
    }
    guard await openURL(url) else {
      return .error(kind: "io", message: "no app opens \(args.url)")
    }
    return null
  }
}
