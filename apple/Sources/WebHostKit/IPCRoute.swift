public import Foundation
public import TypesShared

/// Answers `POST reflect-app://localhost/__ipc/<command>`. A command in
/// `shellCommands` runs in the shell; any other `host.` or `plugin:` command
/// is unknown; the rest goes to the core.
///
/// A JSON request carries the arguments as its body. An
/// `application/octet-stream` request carries raw bytes, and its headers
/// reach the command. The reply is JSON, `application/octet-stream` bytes, or
/// a `{kind, message}` body with `x-reflect-response: error`, always with
/// status 200.
///
/// Only a trusted caller runs a command: any other request answers 403
/// before the route reads the body. The body must be `application/json` or
/// `application/octet-stream`, which no cross-origin page can send without a
/// preflight.
///
/// WebKit stops a task when the page aborts the request or goes away. The
/// route then drops the reply; the command itself runs to its end, because a
/// write must not stop halfway.
@MainActor
public final class IPCRoute: SchemeRoute {
  public typealias Dispatch =
    @Sendable (_ command: String, _ args: Data, _ headers: Data, _ body: Data) async -> CoreReply

  public let pathPrefix = "/__ipc/"

  private let dispatch: Dispatch
  private let shellCommands: [ShellCommandName: ShellCommand]
  private let callers: TrustedCallers

  public init(
    dispatch: @escaping Dispatch,
    shellCommands: [ShellCommandName: ShellCommand],
    callers: TrustedCallers = TrustedCallers()
  ) {
    self.dispatch = dispatch
    self.shellCommands = shellCommands
    self.callers = callers
  }

  public func start(_ task: SchemeTask) {
    let request = task.request
    let corsHeaders = callers.corsHeaders(for: request)
    guard callers.trustedOrigin(of: request) != nil else {
      task.reply(SchemeReply(statusCode: 403, headers: [:], body: Data()))
      return
    }
    if request.httpMethod == "OPTIONS" {
      task.reply(SchemeReply(statusCode: 204, headers: corsHeaders, body: Data()))
      return
    }

    var headers: [String: String] = [:]
    for (name, value) in request.allHTTPHeaderFields ?? [:] {
      headers[name.lowercased()] = value
    }
    // The media type without its parameters, such as `; charset=utf-8`.
    let mediaType = (headers["content-type"] ?? "").split(separator: ";").first
      .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    let isBinary = mediaType == "application/octet-stream"
    guard isBinary || mediaType == "application/json" else {
      task.reply(SchemeReply(statusCode: 415, headers: corsHeaders, body: Data()))
      return
    }
    guard request.httpMethod == "POST", let command = command(of: request),
      let body = task.body
    else {
      task.reply(SchemeReply(statusCode: 400, headers: corsHeaders, body: Data()))
      return
    }

    let shellRequest = ShellRequest(
      args: isBinary ? Data() : body, headers: headers, body: isBinary ? body : Data())

    Task {
      let reply = await run(command, shellRequest)
      task.reply(schemeReply(for: reply, corsHeaders: corsHeaders))
    }
  }

  private func run(_ command: String, _ request: ShellRequest) async -> CoreReply {
    if let name = ShellCommandName(rawValue: command), let shellCommand = shellCommands[name] {
      return await shellCommand(request)
    }
    if command.hasPrefix("host.") || command.hasPrefix("plugin:") {
      return .error(.notFound(.init(message: "the shell has no command \"\(command)\"")))
    }
    let headers = (try? JSONSerialization.data(withJSONObject: request.headers)) ?? Data()
    return await dispatch(command, request.args, headers, request.body)
  }

  /// The percent-decoded command after the path prefix.
  private func command(of request: URLRequest) -> String? {
    guard let url = request.url,
      let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
      path.hasPrefix(pathPrefix),
      let command = path.dropFirst(pathPrefix.count).removingPercentEncoding,
      !command.isEmpty
    else { return nil }
    return command
  }

  private func schemeReply(for reply: CoreReply, corsHeaders: [String: String]) -> SchemeReply {
    var headers = corsHeaders
    headers["Cache-Control"] = "no-store"
    let body: Data
    switch reply {
    case .json(let json):
      headers["Content-Type"] = "application/json"
      body = json
    case .bytes(let bytes):
      headers["Content-Type"] = "application/octet-stream"
      body = bytes
    case .error(let json):
      headers["Content-Type"] = "application/json"
      headers["x-reflect-response"] = "error"
      body = json
    }
    headers["Content-Length"] = String(body.count)
    return SchemeReply(statusCode: 200, headers: headers, body: body)
  }
}
