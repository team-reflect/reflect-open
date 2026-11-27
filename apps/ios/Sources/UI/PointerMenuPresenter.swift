import ChromeKit
import TypesShared
import UIKit
import WebKit

/// Shows the page's context menu where a pointer's secondary click lands on
/// the web view. The click asks the page for its items, and the menu opens
/// when the answer has items. Touch input never asks.
@MainActor
final class PointerMenuPresenter: NSObject, UIGestureRecognizerDelegate {
  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }
  /// Whether the page listens for intents.
  var canAsk: () -> Bool = { false }

  private weak var webView: WKWebView?
  /// The invisible button that presents the open menu.
  private var anchor: UIButton?
  private var lastRequest = 0
  /// The request that waits for the page, and where its click landed.
  private var pending: (request: Int, point: CGPoint)?
  /// Whether the latest touch the click recognizer got is a pointer's.
  private var isPointer = false

  init(webView: WKWebView) {
    self.webView = webView
    super.init()
    let click = UITapGestureRecognizer(target: self, action: #selector(secondaryClick(_:)))
    click.buttonMaskRequired = .secondary
    click.cancelsTouchesInView = false
    click.delaysTouchesEnded = false
    click.delegate = self
    webView.addGestureRecognizer(click)
  }

  /// The page answered `menu.request`: opens its menu, if it has items.
  func answer(_ menu: ChromeMessageContextmenuData) {
    guard let pending, pending.request == menu.request else { return }
    self.pending = nil
    guard !menu.items.isEmpty, let webView else { return }
    let request = menu.request
    // A new button for each menu: one that is still closing would show the
    // new items in its old place.
    let anchor = UIButton(type: .custom)
    anchor.showsMenuAsPrimaryAction = true
    anchor.preferredMenuElementOrder = .fixed
    anchor.isUserInteractionEnabled = false
    anchor.menu = MenuBuilder.menu(menu.items) { [weak self] action in
      self?.send(.contextMenuSelect(.init(request: request, id: action.id)))
    }
    // The menu opens below the button from its leading edge, so a button at
    // least as wide as the menu puts the menu's top left at the click.
    anchor.frame = CGRect(x: pending.point.x, y: pending.point.y, width: 250, height: 1)
    webView.addSubview(anchor)
    self.anchor = anchor
    anchor.performPrimaryAction()
  }

  /// A new document started: closes the menu, and the request that waits
  /// gets no menu.
  func reset() {
    pending = nil
    closeMenu()
  }

  private func closeMenu() {
    anchor?.contextMenuInteraction?.dismissMenu()
    anchor?.removeFromSuperview()
    anchor = nil
  }

  /// Closes the open menu and asks the page for the menu at the click. The
  /// web view's scroll view never moves or zooms, so a point in the web view
  /// is a point in CSS px.
  @objc private func secondaryClick(_ click: UITapGestureRecognizer) {
    guard isPointer else { return }
    closeMenu()
    guard canAsk(), let webView else { return }
    let point = click.location(in: webView)
    lastRequest += 1
    pending = (lastRequest, point)
    send(.contextMenu(.init(request: lastRequest, x: point.x, y: point.y)))
  }

  /// Notes whether the click is a pointer's: the button mask alone also lets
  /// a touch long press through. It takes every touch: a recognizer that
  /// refuses touches changes the edit menu of a text selection made by touch.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
  ) -> Bool {
    isPointer = touch.type == .indirectPointer
    return true
  }

  /// Lets the web view's own recognizers see the click too.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }
}
