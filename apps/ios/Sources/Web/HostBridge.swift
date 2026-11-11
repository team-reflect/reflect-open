import Foundation
import WebKit

/// Delivers shell events to the page through `window.__reflectHost`.
///
/// A user script defines `__reflectHost` before any page script runs. The
/// page subscribes with `on(name, handler)`, and the shell delivers an event
/// by evaluating `__reflectHost.dispatch(name, payload)`.
///
/// No event is lost because the page was not ready for it:
///
/// - Before the first document exists, events wait in the shell. The user
///   script reports each new document, and the shell then sends the queue in
///   order.
/// - In the page, an event whose name has no listener yet waits in the
///   bridge. The first listener of that name gets the waiting events in
///   order, before any later event.
///
/// Both queues are bounded and drop their oldest events first. A new document
/// starts with an empty bridge: the page reads its state again when it boots,
/// so events for the old document are not replayed.
@MainActor
final class HostBridge: NSObject, WKScriptMessageHandler {
  /// The name of the script message handler that the user script posts to.
  static let messageHandlerName = "reflectHost"

  /// The most events that wait in the shell for the first document.
  static let queueLimit = 1024

  /// The most events of one name that wait in the page for a listener.
  static let pendingLimit = 64

  /// Defines `window.__reflectHost` and reports each new document.
  static let userScript = WKUserScript(
    source: """
      (() => {
        const listeners = new Map()
        const pending = new Map()
        const run = (handler, payload) => {
          try {
            handler(payload)
          } catch (error) {
            console.error(error)
          }
        }
        const host = {
          on(name, handler) {
            let handlers = listeners.get(name)
            if (handlers === undefined) {
              handlers = new Set()
              listeners.set(name, handlers)
            }
            handlers.add(handler)
            const waiting = pending.get(name)
            if (waiting !== undefined) {
              pending.delete(name)
              queueMicrotask(() => {
                for (const payload of waiting) {
                  if (handlers.has(handler)) {
                    run(handler, payload)
                  }
                }
              })
            }
            return () => {
              handlers.delete(handler)
            }
          },
          dispatch(name, payload) {
            const handlers = listeners.get(name)
            if (handlers === undefined || handlers.size === 0) {
              const waiting = pending.get(name) ?? []
              waiting.push(payload)
              if (waiting.length > \(pendingLimit)) {
                waiting.shift()
              }
              pending.set(name, waiting)
              return
            }
            for (const handler of [...handlers]) {
              run(handler, payload)
            }
          },
        }
        Object.defineProperty(window, '__reflectHost', { value: Object.freeze(host) })
        window.webkit.messageHandlers.\(messageHandlerName).postMessage('document-start')
      })()
      """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true)

  /// Evaluates JavaScript in the page. The web view sets it.
  var evaluate: (String) -> Void = { _ in }

  /// Whether a document reported that it has `__reflectHost`.
  private(set) var hasDocument = false
  private var queue: [String] = []

  /// Delivers an event with a JSON payload; empty data is `null`.
  func emit(_ name: String, payload: Data) {
    guard let nameJSON = try? JSONEncoder().encode(name) else { return }
    let payloadJSON = payload.isEmpty ? "null" : String(decoding: payload, as: UTF8.self)
    let script =
      "window.__reflectHost.dispatch(\(String(decoding: nameJSON, as: UTF8.self)), \(payloadJSON))"
    if hasDocument {
      evaluate(script)
      return
    }
    queue.append(script)
    if queue.count > Self.queueLimit {
      queue.removeFirst(queue.count - Self.queueLimit)
    }
  }

  /// A document with `__reflectHost` exists: sends the queue.
  func documentDidStart() {
    hasDocument = true
    let scripts = queue
    queue = []
    for script in scripts {
      evaluate(script)
    }
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    if message.frameInfo.isMainFrame, message.body as? String == "document-start" {
      documentDidStart()
    }
  }
}
