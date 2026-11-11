public import Foundation

/// Serves `reflect-app://localhost/__http?url=<target>`: it sends the request to
/// the target from native code and streams the response back to the scheme task.
/// The native request carries no `Origin`, so webview CORS does not apply to it.
@MainActor
public final class HTTPProxy: SchemeRoute {
  public let pathPrefix = "/__http"

  /// Request headers that stay in the webview: browser context, cookies,
  /// headers that `URLSession` sets itself, and hop-by-hop headers.
  public static let droppedRequestHeaders: Set<String> = hopByHopHeaders.union([
    "accept-encoding", "content-length", "cookie", "cookie2", "host", "origin", "referer",
    "user-agent",
  ])

  /// Response headers that stay in the proxy: cookies (the session keeps none),
  /// the target's own CORS policy, and hop-by-hop headers.
  public static let droppedResponseHeaders: Set<String> = hopByHopHeaders.union([
    "access-control-allow-credentials", "access-control-allow-headers",
    "access-control-allow-methods", "access-control-allow-origin",
    "access-control-expose-headers", "access-control-max-age", "set-cookie", "set-cookie2",
  ])

  private static let hopByHopHeaders: Set<String> = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
    "te", "trailer", "transfer-encoding", "upgrade",
  ]

  /// The configuration of the shared session: no cookies, no cache, no waiting
  /// for a network, and 60 s without data fails a request.
  public nonisolated static func makeConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 60
    return configuration
  }

  private let session: URLSession
  private var exchanges: [Int: Exchange] = [:]

  private let callers: TrustedCallers

  /// Only a caller that `callers` trusts gets a request sent: any other
  /// page would use the route to reach hosts its own origin cannot read,
  /// such as servers on the local network.
  public init(
    callers: TrustedCallers = TrustedCallers(),
    configuration: URLSessionConfiguration = HTTPProxy.makeConfiguration()
  ) {
    self.callers = callers
    let delegate = SessionDelegate()
    session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: .main)
    delegate.proxy = self
  }

  deinit {
    session.invalidateAndCancel()
  }

  /// Starts the request of a `__http` scheme task. Answers a CORS preflight and
  /// an invalid target at once, without a network request.
  public func start(_ task: SchemeTask) {
    let request = task.request
    guard let origin = callers.trustedOrigin(of: request) else {
      task.reply(SchemeReply(statusCode: 403, headers: [:], body: Data()))
      return
    }
    let cors = corsHeaders(forOrigin: origin)

    if request.httpMethod == "OPTIONS",
      let method = request.value(forHTTPHeaderField: "Access-Control-Request-Method")
    {
      var headers = cors
      headers["Access-Control-Allow-Methods"] = method
      headers["Access-Control-Allow-Headers"] =
        request.value(forHTTPHeaderField: "Access-Control-Request-Headers")
      headers["Access-Control-Max-Age"] = "600"
      task.reply(SchemeReply(statusCode: 204, headers: headers, body: Data()))
      return
    }

    guard let target = Self.targetURL(of: request), let body = task.body else {
      var headers = cors
      headers["Content-Type"] = "text/plain; charset=utf-8"
      let message = Data("The url query item must be an absolute http or https URL.".utf8)
      task.reply(SchemeReply(statusCode: 400, headers: headers, body: message))
      return
    }

    let sessionTask = session.dataTask(
      with: Self.targetRequest(for: request, to: target, body: body))
    let id = sessionTask.taskIdentifier
    exchanges[id] = Exchange(task: task, corsHeaders: cors)
    task.onStop { [weak self] in
      self?.exchanges[id] = nil
      sessionTask.cancel()
    }
    sessionTask.resume()
  }

  fileprivate func receive(_ response: URLResponse, for sessionTask: URLSessionTask)
    -> URLSession.ResponseDisposition
  {
    guard let exchange = exchanges[sessionTask.taskIdentifier],
      let upstream = response as? HTTPURLResponse
    else { return .cancel }
    var headers = Self.responseHeaders(of: upstream)
    headers.merge(exchange.corsHeaders) { _, cors in cors }
    exchange.didSendHead = true
    exchange.task.respond(status: upstream.statusCode, headers: headers)
    return .allow
  }

  fileprivate func receive(_ data: Data, for sessionTask: URLSessionTask) {
    exchanges[sessionTask.taskIdentifier]?.task.send(data)
  }

  fileprivate func complete(_ sessionTask: URLSessionTask, error: (any Error)?) {
    guard let exchange = exchanges.removeValue(forKey: sessionTask.taskIdentifier) else { return }
    if let error {
      exchange.task.fail(error)
    } else if exchange.didSendHead {
      exchange.task.finish()
    } else {
      exchange.task.fail(URLError(.badServerResponse))
    }
  }

  /// CORS headers for a request from the dev server page. The bundled web
  /// app is same-origin and gets none.
  private func corsHeaders(forOrigin origin: String) -> [String: String] {
    guard origin == callers.devOrigin else { return [:] }
    return ["Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "*"]
  }

  /// The `url` query item, when it is an absolute `http` or `https` URL with a host.
  private static func targetURL(of request: URLRequest) -> URL? {
    guard let url = request.url,
      let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "url" })?.value,
      let target = URLComponents(string: value),
      let scheme = target.scheme?.lowercased(), scheme == "http" || scheme == "https",
      target.host?.isEmpty == false
    else { return nil }
    return target.url
  }

  private static func targetRequest(for request: URLRequest, to target: URL, body: Data)
    -> URLRequest
  {
    var targetRequest = URLRequest(url: target)
    targetRequest.httpMethod = request.httpMethod ?? "GET"
    let fields = request.allHTTPHeaderFields ?? [:]
    let dropped = droppedRequestHeaders.union(connectionTokens(fields["Connection"]))
    for (name, value) in fields where !dropped.contains(name.lowercased()) {
      targetRequest.setValue(value, forHTTPHeaderField: name)
    }
    if !body.isEmpty {
      targetRequest.httpBody = body
    }
    return targetRequest
  }

  /// The target's headers minus `droppedResponseHeaders`. `URLSession` has
  /// already decoded a compressed body, so a response with `Content-Encoding`
  /// loses that header and its `Content-Length`, which counts the encoded bytes.
  private static func responseHeaders(of response: HTTPURLResponse) -> [String: String] {
    var dropped = droppedResponseHeaders.union(
      connectionTokens(response.value(forHTTPHeaderField: "Connection")))
    if response.value(forHTTPHeaderField: "Content-Encoding") != nil {
      dropped.formUnion(["content-encoding", "content-length"])
    }
    var headers: [String: String] = [:]
    for (key, value) in response.allHeaderFields {
      guard let name = key as? String, !dropped.contains(name.lowercased()) else { continue }
      headers[name] = "\(value)"
    }
    return headers
  }

  /// The header names listed in a `Connection` header, which are hop-by-hop too.
  private static func connectionTokens(_ value: String?) -> Set<String> {
    guard let value else { return [] }
    return Set(
      value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() })
  }

  /// Strips credentials when a redirect leaves the target's origin, as `fetch` does.
  nonisolated fileprivate static func redirectRequest(
    _ request: URLRequest, from original: URLRequest?
  ) -> URLRequest {
    guard let from = original?.url, let to = request.url,
      from.scheme != to.scheme || from.host != to.host
        || from.effectivePort != to.effectivePort
    else { return request }
    var request = request
    request.setValue(nil, forHTTPHeaderField: "Authorization")
    return request
  }
}

/// One proxied request, from `start` until the request completes or WebKit
/// stops the scheme task.
@MainActor
private final class Exchange {
  let task: SchemeTask
  let corsHeaders: [String: String]
  var didSendHead = false

  init(task: SchemeTask, corsHeaders: [String: String]) {
    self.task = task
    self.corsHeaders = corsHeaders
  }
}

/// Forwards the session's callbacks to the proxy. The session retains this
/// delegate and calls it on the main queue; the delegate holds the proxy weakly.
private final class SessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  weak var proxy: HTTPProxy?

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    let disposition = MainActor.assumeIsolated {
      proxy?.receive(response, for: dataTask) ?? .cancel
    }
    completionHandler(disposition)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    MainActor.assumeIsolated {
      proxy?.receive(data, for: dataTask)
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?
  ) {
    MainActor.assumeIsolated {
      proxy?.complete(task, error: error)
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(HTTPProxy.redirectRequest(request, from: task.originalRequest))
  }
}
