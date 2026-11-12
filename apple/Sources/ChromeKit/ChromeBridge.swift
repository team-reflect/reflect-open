public import Foundation
public import WebKit

/// Receives the page's chrome messages on the `reflectChrome` handler and
/// sends native intents back.
///
/// The bridge keeps the latest state and drops a state older than it. Each
/// new document resets the bridge: it drops the state, and it drops intents
/// until the page posts `chromeReady`, so a reload never replays old taps.
@MainActor
public final class ChromeBridge: NSObject, WKScriptMessageHandler {
  /// The name of the script message handler that the page posts to.
  public static let messageHandlerName = "reflectChrome"

  /// Reports each new document of the main frame.
  public static let userScript = WKUserScript(
    source:
      "window.webkit.messageHandlers.\(messageHandlerName).postMessage({ type: 'documentStart' })",
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true)

  /// Sends the JSON of one intent to the page.
  public var send: (Data) -> Void = { _ in }
  /// Called with every state newer than the last one.
  public var onState: (ChromeState) -> Void = { _ in }
  /// Called when a web push or pop slide starts (`true`) or ends (`false`).
  public var onTransition: (Bool) -> Void = { _ in }
  /// Called when a new document starts: the shell drops what it shows for the old one.
  public var onReset: () -> Void = {}
  /// Called with a message the bridge could not decode.
  public var onError: (String) -> Void = { _ in }

  /// The latest state of the current document.
  public private(set) var state: ChromeState?
  /// Whether the current document listens for intents.
  public private(set) var isReady = false

  /// Handles one message as JSON data.
  public func receive(_ data: Data) {
    let message: ChromeMessage
    do {
      message = try JSONDecoder().decode(ChromeMessage.self, from: data)
    } catch {
      onError("chrome message: \(error)")
      return
    }
    switch message {
    case .state(let next):
      if let state, next.generation <= state.generation { return }
      state = next
      onState(next)
    case .transition(let started):
      onTransition(started)
    case .chromeReady:
      isReady = true
    case .documentStart:
      documentDidStart()
    }
  }

  /// A new document started: drops the state and waits for `chromeReady`.
  public func documentDidStart() {
    state = nil
    isReady = false
    onReset()
  }

  /// Sends `intent` to the page, or drops it while the page does not listen.
  public func send(_ intent: ChromeIntent) {
    guard isReady, let data = try? JSONEncoder().encode(intent) else { return }
    send(data)
  }

  public func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame else { return }
    if let text = message.body as? String {
      receive(Data(text.utf8))
    } else if JSONSerialization.isValidJSONObject(message.body),
      let data = try? JSONSerialization.data(withJSONObject: message.body)
    {
      receive(data)
    }
  }
}
