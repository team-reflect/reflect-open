import Foundation
import WebKit

/// Serves `reflect-app://localhost/__http?url=<target>`: it sends the request to
/// the target from native code and streams the response back to the scheme task.
/// The native request carries no `Origin`, so webview CORS does not apply to it.
@MainActor
final class HTTPProxy {
  static let path = "/__http"

  /// The origin of the bundled web app. Requests from any other origin (the Vite
  /// dev server) get CORS headers.
  static let pageOrigin = "reflect-app://localhost"

  /// Request headers that stay in the webview: browser context, cookies,
  /// headers that `URLSession` sets itself, and hop-by-hop headers.
  static let droppedRequestHeaders: Set<String> = hopByHopHeaders.union([
    "accept-encoding", "content-length", "cookie", "cookie2", "host", "origin", "referer",
    "user-agent",
  ])

  /// Response headers that stay in the proxy: cookies (the session keeps none),
  /// the target's own CORS policy, and hop-by-hop headers.
  static let droppedResponseHeaders: Set<String> = hopByHopHeaders.union([
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
  static func makeConfiguration() -> URLSessionConfiguration {
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
  private var exchangesBySchemeTask: [ObjectIdentifier: Exchange] = [:]
  private var exchangesBySessionTask: [Int: Exchange] = [:]

  init(configuration: URLSessionConfiguration = HTTPProxy.makeConfiguration()) {
    let delegate = SessionDelegate()
    session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: .main)
    delegate.proxy = self
  }

  deinit {
    session.invalidateAndCancel()
  }

  /// Starts the request of a `__http` scheme task. Answers a CORS preflight and
  /// an invalid target at once, without a network request.
  func start(_ schemeTask: any WKURLSchemeTask) {
    let request = schemeTask.request
    let cors = Self.corsHeaders(for: request)

    if request.httpMethod == "OPTIONS",
      let method = request.value(forHTTPHeaderField: "Access-Control-Request-Method")
    {
      var headers = cors
      headers["Access-Control-Allow-Methods"] = method
      headers["Access-Control-Allow-Headers"] =
        request.value(forHTTPHeaderField: "Access-Control-Request-Headers")
      headers["Access-Control-Max-Age"] = "600"
      Self.send(SchemeReply(statusCode: 204, headers: headers, body: Data()), to: schemeTask)
      return
    }

    guard let target = Self.targetURL(of: request), let body = Self.body(of: request) else {
      var headers = cors
      headers["Content-Type"] = "text/plain; charset=utf-8"
      let message = Data("The url query item must be an absolute http or https URL.".utf8)
      Self.send(SchemeReply(statusCode: 400, headers: headers, body: message), to: schemeTask)
      return
    }

    let sessionTask = session.dataTask(
      with: Self.targetRequest(for: request, to: target, body: body))
    let exchange = Exchange(schemeTask: schemeTask, sessionTask: sessionTask, corsHeaders: cors)
    exchangesBySchemeTask[ObjectIdentifier(schemeTask)] = exchange
    exchangesBySessionTask[sessionTask.taskIdentifier] = exchange
    sessionTask.resume()
  }

  /// WebKit stopped the scheme task: cancel its request and never call the task again.
  func stop(_ schemeTask: any WKURLSchemeTask) {
    guard let exchange = exchangesBySchemeTask[ObjectIdentifier(schemeTask)] else { return }
    remove(exchange)
    exchange.sessionTask.cancel()
  }

  fileprivate func receive(_ response: URLResponse, for sessionTask: URLSessionTask)
    -> URLSession.ResponseDisposition
  {
    guard let exchange = exchangesBySessionTask[sessionTask.taskIdentifier],
      let schemeURL = exchange.schemeTask.request.url,
      let upstream = response as? HTTPURLResponse
    else { return .cancel }
    var headers = Self.responseHeaders(of: upstream)
    headers.merge(exchange.corsHeaders) { _, cors in cors }
    guard
      let head = HTTPURLResponse(
        url: schemeURL, statusCode: upstream.statusCode, httpVersion: "HTTP/1.1",
        headerFields: headers)
    else { return .cancel }
    exchange.didSendHead = true
    exchange.schemeTask.didReceive(head)
    return .allow
  }

  fileprivate func receive(_ data: Data, for sessionTask: URLSessionTask) {
    exchangesBySessionTask[sessionTask.taskIdentifier]?.schemeTask.didReceive(data)
  }

  fileprivate func complete(_ sessionTask: URLSessionTask, error: (any Error)?) {
    guard let exchange = exchangesBySessionTask[sessionTask.taskIdentifier] else { return }
    remove(exchange)
    if let error {
      exchange.schemeTask.didFailWithError(error)
    } else if exchange.didSendHead {
      exchange.schemeTask.didFinish()
    } else {
      exchange.schemeTask.didFailWithError(URLError(.badServerResponse))
    }
  }

  private func remove(_ exchange: Exchange) {
    exchangesBySchemeTask[ObjectIdentifier(exchange.schemeTask)] = nil
    exchangesBySessionTask[exchange.sessionTask.taskIdentifier] = nil
  }

  /// CORS headers for a request from a page outside `pageOrigin`, else none.
  private static func corsHeaders(for request: URLRequest) -> [String: String] {
    guard let origin = request.value(forHTTPHeaderField: "Origin"), origin != pageOrigin else {
      return [:]
    }
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

  /// WebKit hands the buffered body over as `httpBody` or as `httpBodyStream`.
  /// Returns nil when the stream fails.
  private static func body(of request: URLRequest) -> Data? {
    if let body = request.httpBody {
      return body
    }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count < 0 {
        return nil
      }
      if count == 0 {
        return body
      }
      body.append(buffer, count: count)
    }
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

  private static func send(_ reply: SchemeReply, to schemeTask: any WKURLSchemeTask) {
    guard let url = schemeTask.request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: reply.statusCode, httpVersion: "HTTP/1.1",
        headerFields: reply.headers)
    else {
      schemeTask.didFailWithError(URLError(.badURL))
      return
    }
    schemeTask.didReceive(response)
    schemeTask.didReceive(reply.body)
    schemeTask.didFinish()
  }

  /// Strips credentials when a redirect leaves the target's origin, as `fetch` does.
  nonisolated fileprivate static func redirectRequest(
    _ request: URLRequest, from original: URLRequest?
  ) -> URLRequest {
    guard let from = original?.url, let to = request.url,
      from.scheme != to.scheme || from.host != to.host || from.port != to.port
    else { return request }
    var request = request
    request.setValue(nil, forHTTPHeaderField: "Authorization")
    return request
  }
}

/// One proxied request. It lives in the proxy's tables from `start` until the
/// request completes or WebKit stops the scheme task; outside that time nothing
/// calls the scheme task.
@MainActor
private final class Exchange {
  let schemeTask: any WKURLSchemeTask
  let sessionTask: URLSessionDataTask
  let corsHeaders: [String: String]
  var didSendHead = false

  init(
    schemeTask: any WKURLSchemeTask, sessionTask: URLSessionDataTask,
    corsHeaders: [String: String]
  ) {
    self.schemeTask = schemeTask
    self.sessionTask = sessionTask
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
