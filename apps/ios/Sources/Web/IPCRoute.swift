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

/// The pages that may call the privileged routes of the `reflect-app` scheme.
///
/// A web view also runs documents that are not the web app: embeds in
/// subframes, and any page a navigation reaches. Their requests arrive at the
/// scheme handler like the app's own, so each request is checked by the
/// headers that WebKit sets and page script cannot change:
///
/// - A cross-origin request carries `Origin`. It must be the bundled app's
///   origin or the dev server's. An opaque origin (`null`) is refused.
/// - A same-origin request from the bundled app carries no `Origin`. It is
///   trusted only by its `Referer`, which must be a URL of the bundled app
///   or the dev server.
/// - A request with neither header is refused.
struct TrustedCallers: Sendable {
  /// The origin of the bundled web app.
  static let appOrigin = "reflect-app://localhost"

  /// The origin of a dev server page that hosts the web app, if any.
  var devOrigin: String?

  /// The origin of the caller when it is trusted, else nil.
  func trustedOrigin(of request: URLRequest) -> String? {
    let origin =
      request.value(forHTTPHeaderField: "Origin")
      ?? request.value(forHTTPHeaderField: "Referer").flatMap(Self.origin(ofURL:))
    guard let origin, origin == Self.appOrigin || origin == devOrigin else { return nil }
    return origin
  }

  /// The CORS headers that let the dev server page read a response. The
  /// bundled web app is same-origin and needs none.
  func corsHeaders(for request: URLRequest) -> [String: String] {
    guard let devOrigin, trustedOrigin(of: request) == devOrigin else { return [:] }
    return [
      "Access-Control-Allow-Origin": devOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "x-reflect-response",
      "Vary": "Origin",
    ]
  }

  /// The origin of a URL string: scheme, host, and the port when it is not
  /// the default of `http` or `https`.
  private static func origin(ofURL string: String) -> String? {
    guard let components = URLComponents(string: string), let scheme = components.scheme,
      let host = components.host, !host.isEmpty
    else { return nil }
    let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
    guard let port = components.port, port != defaultPort else { return "\(scheme)://\(host)" }
    return "\(scheme)://\(host):\(port)"
  }
}

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
final class IPCRoute: SchemeRoute {
  typealias Dispatch =
    @Sendable (_ command: String, _ args: Data, _ headers: Data, _ body: Data) async -> CoreReply

  let pathPrefix = "/__ipc/"

  private let dispatch: Dispatch
  private let shellCommands: [String: ShellCommand]
  private let callers: TrustedCallers

  init(
    dispatch: @escaping Dispatch,
    shellCommands: [String: ShellCommand],
    callers: TrustedCallers = TrustedCallers()
  ) {
    self.dispatch = dispatch
    self.shellCommands = shellCommands
    self.callers = callers
  }

  func start(_ task: SchemeTask) {
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
