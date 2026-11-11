import Foundation

/// The request of a command that the shell answers itself.
struct ShellRequest: Sendable {
  /// The JSON object of camelCase arguments; empty for a binary request.
  var args: Data
  /// The request headers under lowercase names.
  var headers: [String: String]
  /// The raw body of a binary request; empty otherwise.
  var body: Data
}

/// A command that the shell answers itself: a `host.` command or a
/// `plugin:<name>|<command>` capability.
typealias ShellCommand = @MainActor (ShellRequest) async -> CoreReply

/// Answers `POST reflect-app://localhost/__ipc/<command>`. A command in
/// `shellCommands` runs in the shell; any other `host.` or `plugin:` command
/// is unknown; the rest goes to the core.
///
/// A JSON request carries the arguments as its body. An
/// `application/octet-stream` request carries raw bytes, and its headers
/// reach the command. The reply is JSON, `application/octet-stream` bytes, or
/// a `{kind, message}` body with `x-reflect-response: error`, always with
/// status 200.
@MainActor
final class IPCRoute: SchemeRoute {
  typealias Dispatch =
    @Sendable (_ command: String, _ args: Data, _ headers: Data, _ body: Data) async -> CoreReply

  let pathPrefix = "/__ipc/"

  private let dispatch: Dispatch
  private let shellCommands: [String: ShellCommand]
  private let allowedOrigin: String?
  private let onRequest: () -> Void

  /// `allowedOrigin` is the origin of a dev server page that may call the
  /// route across origins. `onRequest` runs at the start of every request.
  init(
    dispatch: @escaping Dispatch,
    shellCommands: [String: ShellCommand],
    allowedOrigin: String? = nil,
    onRequest: @escaping () -> Void = {}
  ) {
    self.dispatch = dispatch
    self.shellCommands = shellCommands
    self.allowedOrigin = allowedOrigin
    self.onRequest = onRequest
  }

  func start(_ task: SchemeTask) {
    onRequest()
    let request = task.request
    if request.httpMethod == "OPTIONS" {
      task.reply(SchemeReply(statusCode: 204, headers: corsHeaders, body: Data()))
      return
    }
    guard request.httpMethod == "POST", let command = command(of: request),
      let body = task.body
    else {
      task.reply(SchemeReply(statusCode: 400, headers: corsHeaders, body: Data()))
      return
    }

    var headers: [String: String] = [:]
    for (name, value) in request.allHTTPHeaderFields ?? [:] {
      headers[name.lowercased()] = value
    }
    let isBinary = headers["content-type"]?.hasPrefix("application/octet-stream") ?? false
    let shellRequest = ShellRequest(
      args: isBinary ? Data() : body, headers: headers, body: isBinary ? body : Data())

    Task {
      let reply = await run(command, shellRequest)
      task.reply(schemeReply(for: reply))
    }
  }

  private func run(_ command: String, _ request: ShellRequest) async -> CoreReply {
    if let shellCommand = shellCommands[command] {
      return await shellCommand(request)
    }
    if command.hasPrefix("host.") || command.hasPrefix("plugin:") {
      return .error(kind: "notFound", message: "the shell has no command \"\(command)\"")
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

  private func schemeReply(for reply: CoreReply) -> SchemeReply {
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

  private var corsHeaders: [String: String] {
    guard let allowedOrigin else { return [:] }
    return [
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "x-reflect-response",
    ]
  }
}
