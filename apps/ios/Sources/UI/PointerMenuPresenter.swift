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

  private weak var webView: WKWebView?
  private var lastRequest = 0
  /// The request that waits for the page, and the menu's completion.
  private var pending: (request: Int, completion: ([UIMenuElement]) -> Void)?

  init(webView: WKWebView) {
    self.webView = webView
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
    let pending = self.pending
    self.pending = nil
    pending?.completion([])
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard interaction.menuAppearance == .compact, canAsk(), let webView else { return nil }
    // CSS px in the viewport, at page zoom 1.
    let inset = webView.scrollView.adjustedContentInset
    let point = CGPoint(x: location.x - inset.left, y: location.y - inset.top)
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: [
        UIDeferredMenuElement.uncached { [weak self] completion in
          guard let self else { return completion([]) }
          self.ask(at: point, completion: completion)
        }
      ])
    }
  }

  private func ask(at point: CGPoint, completion: @escaping ([UIMenuElement]) -> Void) {
    // A new menu replaces one that still waits: that menu is closed.
    lastRequest += 1
    pending = (lastRequest, completion)
    send(.contextMenu(.init(request: lastRequest, x: point.x, y: point.y)))
  }
}
