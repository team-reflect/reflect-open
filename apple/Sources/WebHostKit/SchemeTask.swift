public import Foundation
public import WebKit

/// One request that WebKit started on the `reflect-app` scheme. WebKit raises
/// an exception when a reply reaches a task after `stop` or after the task
/// ended, so every reply goes through this type, which drops it then.
@MainActor
public final class SchemeTask {
  public let request: URLRequest

  private let task: any WKURLSchemeTask
  private var isEnded = false
  private var endHandlers: [() -> Void] = []
  private var stopHandlers: [() -> Void] = []

  public init(_ task: any WKURLSchemeTask) {
    self.task = task
    self.request = task.request
  }

  /// Whether replies still reach WebKit: false after `stop`, `finish` or `fail`.
  public var isLive: Bool { !isEnded }

  /// The buffered request body. WebKit hands it over as `httpBody` or as
  /// `httpBodyStream`. Returns nil when the stream fails.
  public var body: Data? {
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
  public func onStop(_ handler: @escaping () -> Void) {
    stopHandlers.append(handler)
  }

  /// Runs `handler` once when the task ends for any reason.
  public func onEnd(_ handler: @escaping () -> Void) {
    endHandlers.append(handler)
  }

  /// WebKit stopped the task: the page cancelled the request or went away.
  public func stop() {
    guard isLive else { return }
    let handlers = stopHandlers
    end()
    for handler in handlers {
      handler()
    }
  }

  /// Sends the status line and headers.
  public func respond(status: Int, headers: [String: String]) {
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
  public func send(_ data: Data) {
    guard isLive else { return }
    task.didReceive(data)
  }

  /// Ends the response.
  public func finish() {
    guard isLive else { return }
    task.didFinish()
    end()
  }

  /// Fails the request: `fetch` rejects in the page.
  public func fail(_ error: any Error) {
    guard isLive else { return }
    task.didFailWithError(error)
    end()
  }

  /// Sends a whole response and ends the task.
  public func reply(_ reply: SchemeReply) {
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

/// The tasks of one scheme handler that WebKit started and that did not end yet.
@MainActor
final class SchemeTasks {
  private var tasks: [ObjectIdentifier: SchemeTask] = [:]

  /// Wraps a task that WebKit started and keeps it until it ends.
  func start(_ urlSchemeTask: any WKURLSchemeTask) -> SchemeTask {
    let id = ObjectIdentifier(urlSchemeTask)
    let task = SchemeTask(urlSchemeTask)
    tasks[id] = task
    task.onEnd { [weak self] in
      self?.tasks[id] = nil
    }
    return task
  }

  /// WebKit stopped a task.
  func stop(_ urlSchemeTask: any WKURLSchemeTask) {
    tasks[ObjectIdentifier(urlSchemeTask)]?.stop()
  }
}
