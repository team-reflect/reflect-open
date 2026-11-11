import Foundation
import WebKit

/// Delivers shell events to the page through `window.__reflectHost`.
///
/// A user script defines `__reflectHost` before any page script runs. The
/// page subscribes with `on(name, handler)`, and the shell delivers an event
/// by evaluating `__reflectHost.dispatch(name, payload)`. Events that arrive
/// before the page is ready wait in a queue: a new document clears "ready",
/// and `markReady` sets it and sends the queue in order.
@MainActor
final class HostBridge: NSObject, WKScriptMessageHandler {
  /// The name of the script message handler that the user script posts to.
  static let messageHandlerName = "reflectHost"

  /// Defines `window.__reflectHost` and reports each new document.
  static let userScript = WKUserScript(
    source: """
      (() => {
        const listeners = new Map()
        const host = {
          on(name, handler) {
            let handlers = listeners.get(name)
            if (handlers === undefined) {
              handlers = new Set()
              listeners.set(name, handlers)
            }
            handlers.add(handler)
            return () => {
              handlers.delete(handler)
            }
          },
          dispatch(name, payload) {
            for (const handler of [...(listeners.get(name) ?? [])]) {
              try {
                handler(payload)
              } catch (error) {
                console.error(error)
              }
            }
          },
        }
        Object.defineProperty(window, '__reflectHost', { value: Object.freeze(host) })
        window.webkit.messageHandlers.\(messageHandlerName).postMessage('document-start')
      })()
      """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true)

  /// The most events that wait for a page that is not ready. The oldest are dropped first.
  static let queueLimit = 1024

  /// Evaluates JavaScript in the page. The web view sets it.
  var evaluate: (String) -> Void = { _ in }

  private var isReady = false
  private var queue: [String] = []

  /// Delivers an event with a JSON payload; empty data is `null`.
  func emit(_ name: String, payload: Data) {
    guard let nameJSON = try? JSONEncoder().encode(name) else { return }
    let payloadJSON = payload.isEmpty ? "null" : String(decoding: payload, as: UTF8.self)
    let script =
      "window.__reflectHost.dispatch(\(String(decoding: nameJSON, as: UTF8.self)), \(payloadJSON))"
    if isReady {
      evaluate(script)
      return
    }
    queue.append(script)
    if queue.count > Self.queueLimit {
      queue.removeFirst(queue.count - Self.queueLimit)
    }
  }

  /// The page runs and can receive events: sends the queue.
  func markReady() {
    guard !isReady else { return }
    isReady = true
    let scripts = queue
    queue = []
    for script in scripts {
      evaluate(script)
    }
  }

  /// A new document replaced the page.
  func reset() {
    isReady = false
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    if message.frameInfo.isMainFrame, message.body as? String == "document-start" {
      reset()
    }
  }
}
