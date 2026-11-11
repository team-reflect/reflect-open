import WebKit
import XCTest

@testable import Reflect

@MainActor
final class HTTPProxyTests: XCTestCase {
  private var proxy: HTTPProxy!

  override func setUp() async throws {
    StubProtocol.reset()
    let configuration = HTTPProxy.makeConfiguration()
    configuration.protocolClasses = [StubProtocol.self]
    proxy = HTTPProxy(configuration: configuration)
  }

  override func tearDown() async throws {
    proxy = nil
  }

  @discardableResult
  private func start(_ task: RecordingSchemeTask) -> SchemeTask {
    let schemeTask = SchemeTask(task)
    proxy.start(schemeTask)
    return schemeTask
  }

  func testForwardsRequestWithoutBrowserHeaders() async throws {
    StubProtocol.respond { stub in
      stub.sendHead(status: 201, headers: ["Content-Type": "application/json"])
      stub.send("{}")
      stub.finish()
    }
    let task = RecordingSchemeTask(
      target: "https://api.example.com/v1/chat?stream=1", method: "POST",
      headers: [
        "Authorization": "Bearer sk-test",
        "Content-Type": "application/json",
        "X-Upload-Id": "42",
        "Origin": HTTPProxy.pageOrigin,
        "Referer": "reflect-app://localhost/index.html",
        "Cookie": "a=1",
        "User-Agent": "Mozilla/5.0",
        "Accept-Encoding": "gzip",
        "Connection": "keep-alive, X-Hop",
        "X-Hop": "1",
        "Keep-Alive": "timeout=5",
      ])
    task.setBodyStream(Data(#"{"model":"gpt-5"}"#.utf8))

    start(task)
    await task.waitUntilDone()

    let request = try XCTUnwrap(StubProtocol.requests.first)
    XCTAssertEqual(request.url?.absoluteString, "https://api.example.com/v1/chat?stream=1")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.body, Data(#"{"model":"gpt-5"}"#.utf8))
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sk-test")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Upload-Id"), "42")
    for name in [
      "Origin", "Referer", "Cookie", "User-Agent", "Accept-Encoding", "Connection", "X-Hop",
      "Keep-Alive",
    ] {
      XCTAssertNil(request.value(forHTTPHeaderField: name), name)
    }
  }

  func testForwardsResponseWithoutCookiesHopByHopOrEncoding() async throws {
    StubProtocol.respond { stub in
      stub.sendHead(
        status: 418,
        headers: [
          "Content-Type": "text/event-stream",
          "X-Request-Id": "req-1",
          "Set-Cookie": "session=1",
          "Connection": "X-Drop",
          "X-Drop": "1",
          "Transfer-Encoding": "chunked",
          "Content-Encoding": "gzip",
          "Content-Length": "99",
          "Access-Control-Allow-Origin": "https://upstream.example",
        ])
      stub.finish()
    }
    let task = RecordingSchemeTask(target: "https://api.example.com/")

    start(task)
    await task.waitUntilDone()

    let head = try XCTUnwrap(task.head)
    XCTAssertEqual(head.statusCode, 418)
    XCTAssertEqual(head.url, task.request.url)
    XCTAssertEqual(head.value(forHTTPHeaderField: "Content-Type"), "text/event-stream")
    XCTAssertEqual(head.value(forHTTPHeaderField: "X-Request-Id"), "req-1")
    for name in [
      "Set-Cookie", "Connection", "X-Drop", "Transfer-Encoding", "Content-Encoding",
      "Content-Length", "Access-Control-Allow-Origin",
    ] {
      XCTAssertNil(head.value(forHTTPHeaderField: name), name)
    }
  }

  func testStreamsHeadThenEachChunkThenFinish() async {
    StubProtocol.respond { stub in
      stub.sendHead(status: 200, headers: ["Content-Type": "text/event-stream"])
      stub.after(0.05) {
        stub.send("data: a\n\n")
        stub.after(0.05) {
          stub.send("data: b\n\n")
          stub.finish()
        }
      }
    }
    let task = RecordingSchemeTask(target: "https://api.example.com/stream")

    start(task)
    await task.waitUntilDone()

    XCTAssertEqual(task.events, [.head(200), .data("data: a\n\n"), .data("data: b\n\n"), .finish])
  }

  func testStopCancelsTheRequestAndSendsNothingMore() async throws {
    StubProtocol.respond { stub in
      stub.sendHead(status: 200, headers: ["Content-Type": "text/event-stream"])
      stub.send("first")
      stub.after(0.2) {
        stub.send("late")
        stub.finish()
      }
    }
    let task = RecordingSchemeTask(target: "https://api.example.com/stream")

    let schemeTask = start(task)
    await task.waitForEvents(count: 2)
    schemeTask.stop()
    try await Task.sleep(nanoseconds: 400_000_000)

    XCTAssertEqual(task.events, [.head(200), .data("first")])
    XCTAssertTrue(StubProtocol.didStopLoading)
  }

  func testTransportErrorFailsTheTask() async {
    StubProtocol.respond { stub in
      stub.fail(URLError(.cannotConnectToHost))
    }
    let task = RecordingSchemeTask(target: "http://192.168.1.20:1234/v1/models")

    start(task)
    await task.waitUntilDone()

    XCTAssertEqual(task.events, [.fail(URLError.cannotConnectToHost.rawValue)])
  }

  func testRejectsATargetThatIsNotHTTP() async {
    for target in ["file:///etc/hosts", "ftp://example.com/a", "not a url", "https://", nil] {
      let task = RecordingSchemeTask(target: target)

      start(task)

      XCTAssertEqual(task.events.first, .head(400), target ?? "nil")
      XCTAssertEqual(task.events.last, .finish, target ?? "nil")
    }
    XCTAssertTrue(StubProtocol.requests.isEmpty)
  }

  func testAnswersAPreflightWithoutTheNetwork() throws {
    let task = RecordingSchemeTask(
      target: "https://api.example.com/", method: "OPTIONS",
      headers: [
        "Origin": "http://localhost:1420",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      ])

    start(task)

    let head = try XCTUnwrap(task.head)
    XCTAssertEqual(head.statusCode, 204)
    XCTAssertEqual(
      head.value(forHTTPHeaderField: "Access-Control-Allow-Origin"), "http://localhost:1420")
    XCTAssertEqual(head.value(forHTTPHeaderField: "Access-Control-Allow-Methods"), "POST")
    XCTAssertEqual(
      head.value(forHTTPHeaderField: "Access-Control-Allow-Headers"),
      "authorization, content-type")
    XCTAssertEqual(task.events.last, .finish)
    XCTAssertTrue(StubProtocol.requests.isEmpty)
  }

  func testAddsCORSHeadersOnlyForAnotherPageOrigin() async throws {
    StubProtocol.respond { stub in
      stub.sendHead(
        status: 200, headers: ["Access-Control-Allow-Origin": "https://upstream.example"])
      stub.finish()
    }
    let devTask = RecordingSchemeTask(
      target: "https://api.example.com/", headers: ["Origin": "http://localhost:1420"])
    let appTask = RecordingSchemeTask(
      target: "https://api.example.com/", headers: ["Origin": HTTPProxy.pageOrigin])

    start(devTask)
    start(appTask)
    await devTask.waitUntilDone()
    await appTask.waitUntilDone()

    let devHead = try XCTUnwrap(devTask.head)
    XCTAssertEqual(
      devHead.value(forHTTPHeaderField: "Access-Control-Allow-Origin"), "http://localhost:1420")
    XCTAssertEqual(devHead.value(forHTTPHeaderField: "Access-Control-Expose-Headers"), "*")
    let appHead = try XCTUnwrap(appTask.head)
    XCTAssertNil(appHead.value(forHTTPHeaderField: "Access-Control-Allow-Origin"))
  }

  func testRedirectKeepsAuthorizationOnlyWithinTheOrigin() async throws {
    StubProtocol.respond { stub in
      switch stub.request.url?.path {
      case "/start":
        stub.redirect(to: "https://api.example.com/same")
      case "/same":
        stub.redirect(to: "https://other.example.com/final")
      default:
        stub.sendHead(status: 200, headers: [:])
        stub.finish()
      }
    }
    let task = RecordingSchemeTask(
      target: "https://api.example.com/start", headers: ["Authorization": "Bearer sk-test"])

    start(task)
    await task.waitUntilDone()

    XCTAssertEqual(task.events, [.head(200), .finish])
    let authorization = StubProtocol.requests.map {
      [$0.url?.absoluteString ?? "", $0.value(forHTTPHeaderField: "Authorization") ?? "none"]
    }
    XCTAssertEqual(
      authorization,
      [
        ["https://api.example.com/start", "Bearer sk-test"],
        ["https://api.example.com/same", "Bearer sk-test"],
        ["https://other.example.com/final", "none"],
      ])
  }
}

/// A `WKURLSchemeTask` that records every call.
@MainActor
private final class RecordingSchemeTask: NSObject, WKURLSchemeTask {
  enum Event: Equatable {
    case head(Int)
    case data(String)
    case finish
    case fail(Int)
  }

  private var urlRequest: URLRequest
  private(set) var events: [Event] = []
  private(set) var head: HTTPURLResponse?

  init(target: String?, method: String = "GET", headers: [String: String] = [:]) {
    var components = URLComponents(string: "reflect-app://localhost/__http")
    components?.queryItems = target.map { [URLQueryItem(name: "url", value: $0)] }
    urlRequest = URLRequest(url: components?.url ?? URL(fileURLWithPath: "/"))
    urlRequest.httpMethod = method
    urlRequest.allHTTPHeaderFields = headers
  }

  nonisolated var request: URLRequest {
    MainActor.assumeIsolated { urlRequest }
  }

  /// Hands the body over as a stream, the form WebKit uses for larger bodies.
  func setBodyStream(_ body: Data) {
    urlRequest.httpBodyStream = InputStream(data: body)
  }

  nonisolated func didReceive(_ response: URLResponse) {
    MainActor.assumeIsolated {
      head = response as? HTTPURLResponse
      events.append(.head(head?.statusCode ?? -1))
    }
  }

  nonisolated func didReceive(_ data: Data) {
    MainActor.assumeIsolated {
      events.append(.data(String(decoding: data, as: UTF8.self)))
    }
  }

  nonisolated func didFinish() {
    MainActor.assumeIsolated {
      events.append(.finish)
    }
  }

  nonisolated func didFailWithError(_ error: any Error) {
    MainActor.assumeIsolated {
      events.append(.fail((error as? URLError)?.errorCode ?? -1))
    }
  }

  func waitUntilDone() async {
    await waitUntil {
      switch $0.events.last {
      case .finish, .fail: true
      default: false
      }
    }
  }

  func waitForEvents(count: Int) async {
    await waitUntil { $0.events.count >= count }
  }

  private func waitUntil(_ condition: (RecordingSchemeTask) -> Bool) async {
    let deadline = Date().addingTimeInterval(5)
    while !condition(self), Date() < deadline {
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }
}

/// A `URLProtocol` that answers every request with the handler set by `respond`.
private final class StubProtocol: URLProtocol, @unchecked Sendable {
  private struct State {
    var handler: (@Sendable (StubProtocol) -> Void)?
    var requests: [URLRequest] = []
    var didStopLoading = false
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var state = State()

  static var requests: [URLRequest] { lock.withLock { state.requests } }
  static var didStopLoading: Bool { lock.withLock { state.didStopLoading } }

  static func reset() {
    lock.withLock { state = State() }
  }

  static func respond(_ handler: @escaping @Sendable (StubProtocol) -> Void) {
    lock.withLock { state.handler = handler }
  }

  private var runLoop: RunLoop?

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    runLoop = RunLoop.current
    var recorded = request
    recorded.httpBody = request.body
    let handler = Self.lock.withLock {
      Self.state.requests.append(recorded)
      return Self.state.handler
    }
    handler?(self)
  }

  override func stopLoading() {
    Self.lock.withLock { Self.state.didStopLoading = true }
  }

  func sendHead(status: Int, headers: [String: String]) {
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
  }

  func send(_ text: String) {
    client?.urlProtocol(self, didLoad: Data(text.utf8))
  }

  func finish() {
    client?.urlProtocolDidFinishLoading(self)
  }

  func fail(_ error: any Error) {
    client?.urlProtocol(self, didFailWithError: error)
  }

  func redirect(to target: String) {
    guard let url = request.url, let targetURL = URL(string: target),
      let response = HTTPURLResponse(
        url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": target])
    else { return }
    var next = request
    next.url = targetURL
    client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
    client?.urlProtocolDidFinishLoading(self)
  }

  /// Runs `body` on the loading thread after a delay.
  func after(_ seconds: TimeInterval, _ body: @escaping @Sendable () -> Void) {
    nonisolated(unsafe) let runLoop = runLoop
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
      runLoop?.perform(body)
    }
  }
}

extension URLRequest {
  /// The body from `httpBody` or `httpBodyStream`.
  fileprivate var body: Data? {
    if let httpBody {
      return httpBody
    }
    guard let stream = httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 {
        return data
      }
      data.append(buffer, count: count)
    }
  }
}
