public import Foundation
public import WebKit

/// Delivers shell events to the page by evaluating
/// `window.__reflectHost.dispatch(name, payload)`.
///
/// The page defines `__reflectHost` when it boots and then posts `ready` to
/// the `reflectHost` script message handler. Until then the events wait in
/// the shell, and go out in order when `ready` arrives. A user script reports
/// each new document, which starts the wait again. The queue is bounded and
/// drops its oldest events first.
@MainActor
public final class HostBridge: NSObject, WKScriptMessageHandler {
  /// The name of the script message handler that the page posts to.
  public static let messageHandlerName = "reflectHost"

  /// The most events that wait in the shell for the page.
  public static let queueLimit = 1024

  /// Reports each new document of the main frame.
  public static let userScript = WKUserScript(
    source: "window.webkit.messageHandlers.\(messageHandlerName).postMessage('document-start')",
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true)

  /// Evaluates JavaScript in the page. The web view sets it.
  public var evaluate: (String) -> Void = { _ in }

  /// Whether the current document posted `ready`.
  public private(set) var isPageReady = false
  private var queue: [String] = []

  /// Delivers an event with a JSON payload; empty data is `null`.
  public func emit(_ name: String, payload: Data) {
    guard let nameJSON = try? JSONEncoder().encode(name) else { return }
    let payloadJSON = payload.isEmpty ? "null" : String(decoding: payload, as: UTF8.self)
    let script =
      "window.__reflectHost.dispatch(\(String(decoding: nameJSON, as: UTF8.self)), \(payloadJSON))"
    if isPageReady {
      evaluate(script)
      return
    }
    queue.append(script)
    if queue.count > Self.queueLimit {
      queue.removeFirst(queue.count - Self.queueLimit)
    }
  }

  /// A new document started to load: events wait for its `ready`.
  public func documentDidStart() {
    isPageReady = false
  }

  /// The page takes events: sends the queue.
  public func pageDidBecomeReady() {
    isPageReady = true
    let scripts = queue
    queue = []
    for script in scripts {
      evaluate(script)
    }
  }

  public func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame else { return }
    switch message.body as? String {
    case "document-start": documentDidStart()
    case "ready": pageDidBecomeReady()
    default: break
    }
  }
}
