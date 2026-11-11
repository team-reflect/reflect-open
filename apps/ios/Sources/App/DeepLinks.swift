import Foundation

/// Delivers the URLs that the system opens the app with to the page. The URLs
/// that arrive before the page asks wait for `host.deep_link_pending`; later
/// ones go out as `host:open-url` events with a `string[]` payload.
@MainActor
final class DeepLinks {
  /// The most URLs that wait for the page. The oldest are dropped first.
  static let pendingLimit = 16

  private let emit: (_ name: String, _ payload: Data) -> Void
  private var pending: [String] = []
  private var didPageAsk = false

  init(emit: @escaping (_ name: String, _ payload: Data) -> Void) {
    self.emit = emit
  }

  /// The system opened the app with `urls`.
  func open(_ urls: [URL]) {
    let urls = urls.map(\.absoluteString)
    guard !urls.isEmpty else { return }
    guard didPageAsk else {
      pending.append(contentsOf: urls)
      pending.removeFirst(max(0, pending.count - Self.pendingLimit))
      return
    }
    if let payload = try? JSONSerialization.data(withJSONObject: urls) {
      emit("host:open-url", payload)
    }
  }

  /// The waiting URLs, once: nil when there are none.
  func takePending() -> [String]? {
    didPageAsk = true
    let urls = pending
    pending = []
    return urls.isEmpty ? nil : urls
  }
}
