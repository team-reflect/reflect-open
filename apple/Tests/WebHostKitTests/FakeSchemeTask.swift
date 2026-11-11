import Foundation
import WebKit

/// A `WKURLSchemeTask` that records what the handler sends to it.
@MainActor
final class FakeSchemeTask: NSObject, @preconcurrency WKURLSchemeTask {
  let request: URLRequest
  private(set) var response: HTTPURLResponse?
  private(set) var body = Data()
  private(set) var isFinished = false
  private(set) var error: (any Error)?

  private var endWaiters: [CheckedContinuation<Void, Never>] = []

  init(_ request: URLRequest) {
    self.request = request
  }

  convenience init(
    path: String, method: String = "GET", headers: [String: String] = [:], body: Data? = nil
  ) {
    var request = URLRequest(
      url: URL(string: "reflect-app://localhost\(path)") ?? URL(fileURLWithPath: "/"))
    request.httpMethod = method
    request.allHTTPHeaderFields = headers
    request.httpBody = body
    self.init(request)
  }

  var hasEnded: Bool { isFinished || error != nil }

  /// Whether the handler sent nothing at all.
  var isUntouched: Bool { response == nil && body.isEmpty && !hasEnded }

  /// Returns after the handler finished or failed the task.
  func waitForEnd() async {
    if hasEnded { return }
    await withCheckedContinuation { endWaiters.append($0) }
  }

  func header(_ name: String) -> String? {
    response?.value(forHTTPHeaderField: name)
  }

  func didReceive(_ response: URLResponse) {
    self.response = response as? HTTPURLResponse
  }

  func didReceive(_ data: Data) {
    body.append(data)
  }

  func didFinish() {
    isFinished = true
    resumeWaiters()
  }

  func didFailWithError(_ error: any Error) {
    self.error = error
    resumeWaiters()
  }

  private func resumeWaiters() {
    let waiters = endWaiters
    endWaiters = []
    for waiter in waiters {
      waiter.resume()
    }
  }
}

/// Lets a test hold an async call until `open()`.
final class Gate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    (stream, continuation) = AsyncStream.makeStream(of: Void.self)
  }

  func open() {
    continuation.finish()
  }

  func wait() async {
    for await _ in stream {}
  }
}
