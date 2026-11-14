public import Foundation
public import TypesShared

/// Receives the page's chrome messages, which come on the shell's
/// `reflectHost` handler, and sends native intents back.
///
/// The bridge keeps the latest state and drops a state older than it. Each
/// new document resets the bridge: it drops the state, and it drops intents
/// until the page posts `chromeReady`, so a reload never replays old taps.
@MainActor
public final class ChromeBridge {
  public init() {}

  /// Sends the JSON of one intent to the page.
  public var send: (Data) -> Void = { _ in }
  /// Called with every state newer than the last one.
  public var onState: (ChromeState) -> Void = { _ in }
  /// Called when a web push or pop slide starts (`true`) or ends (`false`).
  public var onTransition: (Bool) -> Void = { _ in }
  /// Called when a user back swipe starts to move the page (`true`), or
  /// settles back without a pop (`false`).
  public var onBackSwipe: (Bool) -> Void = { _ in }
  /// Called when a new document starts: the shell drops what it shows for the old one.
  public var onReset: () -> Void = {}
  /// Called with a message the bridge could not decode.
  public var onError: (String) -> Void = { _ in }

  /// The latest state of the current document.
  public private(set) var state: ChromeState?
  /// Whether the current document listens for intents.
  public private(set) var isReady = false
  /// Whether the corner buttons sit in the page's header row. The page starts
  /// with `true`; the bridge sends a `layout` intent when the value changes,
  /// and when a page with that start value gets ready.
  public var cornersInHeaderRow = true {
    didSet {
      if cornersInHeaderRow != oldValue {
        send(.layout(.init(cornersInHeaderRow: cornersInHeaderRow)))
      }
    }
  }

  /// Whether the iPad sidebar shows, or `nil` without a sidebar. The page
  /// starts with `nil`; the bridge sends a `sidebarVisible` intent when the
  /// value changes, and when a page gets ready while it is not `nil`.
  public var sidebarVisible: Bool? = nil {
    didSet {
      if sidebarVisible != oldValue {
        send(.sidebarVisible(.init(visible: sidebarVisible)))
      }
    }
  }

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
    case .transition(let transition):
      onTransition(transition.phase == .start)
    case .backSwipe(let swipe):
      onBackSwipe(swipe.phase == .start)
    case .chromeReady:
      isReady = true
      if !cornersInHeaderRow {
        send(.layout(.init(cornersInHeaderRow: false)))
      }
      if let sidebarVisible {
        send(.sidebarVisible(.init(visible: sidebarVisible)))
      }
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

  /// Handles one message body of the script message handler: a JSON string,
  /// or an object that converts to JSON.
  public func receive(body: Any) {
    if let text = body as? String {
      receive(Data(text.utf8))
    } else if JSONSerialization.isValidJSONObject(body),
      let data = try? JSONSerialization.data(withJSONObject: body)
    {
      receive(data)
    } else {
      onError("chrome message: unsupported body \(type(of: body))")
    }
  }
}
