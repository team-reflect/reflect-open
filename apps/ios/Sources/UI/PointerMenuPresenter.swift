import ChromeKit
import TypesShared
import UIKit
import WebKit

/// Shows the page's context menu where a pointer's secondary click lands on
/// the web view. The menu asks the page for its items as it opens; an answer
/// with no items shows no menu. A touch long press shows no menu, so the
/// page gets it as before.
@MainActor
final class PointerMenuPresenter: NSObject, UIContextMenuInteractionDelegate {
  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }
  /// Whether the page listens for intents.
  var canAsk: () -> Bool = { false }

  private var lastRequest = 0
  /// The request that waits for the page, and the menu's completion.
  private var pending: (request: Int, completion: ([UIMenuElement]) -> Void)?

  init(webView: WKWebView) {
    super.init()
    webView.addInteraction(UIContextMenuInteraction(delegate: self))
  }

  /// The page answered `menu.request`: fills the menu that waits for it.
  func answer(_ menu: ChromeMessageContextmenuData) {
    guard let pending, pending.request == menu.request else { return }
    self.pending = nil
    let request = menu.request
    let elements = MenuBuilder.menu(menu.items) { [weak self] action in
      self?.send(.contextMenuSelect(.init(request: request, id: action.id)))
    }.children
    pending.completion(elements)
  }

  /// A new document started: the menu that waits gets no items.
  func reset() {
    finishPending()
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard interaction.menuAppearance == .compact, canAsk() else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: [
        UIDeferredMenuElement.uncached { [weak self] completion in
          guard let self else { return completion([]) }
          self.ask(at: location, completion: completion)
        }
      ])
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    finishPending()
  }

  /// Asks the page for the menu at `point`. The web view's scroll view
  /// never moves or zooms, so a point in the web view is a point in CSS px.
  private func ask(at point: CGPoint, completion: @escaping ([UIMenuElement]) -> Void) {
    finishPending()
    // The document can change between the configuration and this request.
    guard canAsk() else { return completion([]) }
    lastRequest += 1
    pending = (lastRequest, completion)
    send(.contextMenu(.init(request: lastRequest, x: point.x, y: point.y)))
  }

  /// Completes the menu that waits, if any, with no items.
  private func finishPending() {
    let pending = self.pending
    self.pending = nil
    pending?.completion([])
  }
}
