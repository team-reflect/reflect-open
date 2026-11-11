import Foundation
import WebKit

/// One request that WebKit started on the `reflect-app` scheme. WebKit raises
/// an exception when a reply reaches a task after `stop` or after the task
/// ended, so every reply goes through this type, which drops it then.
@MainActor
final class SchemeTask {
  let request: URLRequest

  private let task: any WKURLSchemeTask
  private var isEnded = false
  private var endHandlers: [() -> Void] = []
  private var stopHandlers: [() -> Void] = []

  init(_ task: any WKURLSchemeTask) {
    self.task = task
    self.request = task.request
  }

  /// Whether replies still reach WebKit: false after `stop`, `finish` or `fail`.
  var isLive: Bool { !isEnded }

  /// The buffered request body. WebKit hands it over as `httpBody` or as
  /// `httpBodyStream`. Returns nil when the stream fails.
  var body: Data? {
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

  /// Runs `handler` once when WebKit stops the task before it ended.
  func onStop(_ handler: @escaping () -> Void) {
    stopHandlers.append(handler)
  }

  /// Runs `handler` once when the task ends for any reason.
  func onEnd(_ handler: @escaping () -> Void) {
    endHandlers.append(handler)
  }

  /// WebKit stopped the task: the page cancelled the request or went away.
  func stop() {
    guard isLive else { return }
    let handlers = stopHandlers
    end()
    for handler in handlers {
      handler()
    }
  }

  /// Sends the status line and headers.
  func respond(status: Int, headers: [String: String]) {
    guard isLive else { return }
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
    else {
      fail(URLError(.badURL))
      return
    }
    task.didReceive(response)
  }

  /// Sends one chunk of the body.
  func send(_ data: Data) {
    guard isLive else { return }
    task.didReceive(data)
  }

  /// Ends the response.
  func finish() {
    guard isLive else { return }
    task.didFinish()
    end()
  }

  /// Fails the request: `fetch` rejects in the page.
  func fail(_ error: any Error) {
    guard isLive else { return }
    task.didFailWithError(error)
    end()
  }

  /// Sends a whole response and ends the task.
  func reply(_ reply: SchemeReply) {
    respond(status: reply.statusCode, headers: reply.headers)
    send(reply.body)
    finish()
  }

  private func end() {
    isEnded = true
    let handlers = endHandlers
    endHandlers = []
    stopHandlers = []
    for handler in handlers {
      handler()
    }
  }
}

/// Handles the requests of `reflect-app` paths that start with `pathPrefix`.
@MainActor
protocol SchemeRoute {
  var pathPrefix: String { get }
  func start(_ task: SchemeTask)
}
