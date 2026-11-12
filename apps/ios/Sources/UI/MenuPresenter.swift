import ChromeKit
import UIKit
import WebKit

/// Shows the page's menus as `UIMenu`s and asks before destructive items.
///
/// A menu that the page opens at one of its elements opens from an invisible
/// button over that element. A menu that is still open when the page moves to
/// another history entry closes, and its taps never reach the new page.
@MainActor
final class MenuPresenter {
  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }
  /// The controller that presents confirmations.
  var presenter: () -> UIViewController? = { nil }

  /// An invisible button that anchors a menu at a web element.
  private let anchor = UIButton(type: .system)
  /// The open menu of `presentMenu`: its request, with the checkmarks the user changed.
  private var openRequest: MenuRequest?
  /// The history entry of the open menu or confirmation.
  private var openEntryId: Int?

  init() {
    anchor.alpha = 0
    anchor.showsMenuAsPrimaryAction = true
    anchor.isAccessibilityElement = false
  }

  /// Opens `request`'s menu over its element of `webView`, inside `container`.
  func present(_ request: MenuRequest, webView: WKWebView, in container: UIView) {
    if anchor.superview !== container {
      anchor.removeFromSuperview()
      container.addSubview(anchor)
    }
    let rect = CGRect(
      x: request.rect.x, y: request.rect.y, width: max(request.rect.width, 1),
      height: max(request.rect.height, 1))
    anchor.frame = webView.convert(rect, to: container)
    openRequest = request
    openEntryId = request.entryId
    anchor.menu = menu(for: request)
    CATransaction.flush()
    anchor.performPrimaryAction()
  }

  /// The menu of a bar button: its taps send `action` intents for `entryId`.
  func barMenu(_ items: [MenuItem], entryId: Int, source: @escaping () -> UIBarButtonItem?)
    -> UIMenu
  {
    MenuBuilder.menu(items) { [weak self] action in
      guard let self else { return }
      self.openEntryId = entryId
      self.select(action, intent: .action(entryId: entryId, id: action.id)) {
        source() ?? self.anchor
      }
    }
  }

  /// The page shows `entryId`: closes a menu or confirmation of another entry.
  func pageDidShow(entryId: Int) {
    guard let openEntryId, openEntryId != entryId else { return }
    closeAll()
  }

  /// Closes every open menu and confirmation.
  func closeAll() {
    openEntryId = nil
    openRequest = nil
    anchor.contextMenuInteraction?.dismissMenu()
    if let alert = presenter()?.presentedViewController as? UIAlertController {
      alert.dismiss(animated: true)
    }
  }

  private func menu(for request: MenuRequest) -> UIMenu {
    MenuBuilder.menu(request.items) { [weak self] action in
      self?.select(
        action, intent: .menu(entryId: request.entryId, menuId: request.menuId, id: action.id)
      ) { [weak self] in self?.anchor }
    }
  }

  /// Sends the intent of `action`, after a confirmation when it has one.
  private func select(
    _ action: MenuAction, intent: ChromeIntent,
    source: @escaping () -> (any UIPopoverPresentationControllerSourceItem)?
  ) {
    if action.keepsMenuPresented {
      toggleVisibleCheckmark(of: action.id)
    }
    guard let confirm = action.confirm else {
      send(intent)
      return
    }
    guard let presenter = presenter(), let item = source() else { return }
    let entryId = openEntryId
    let alert = MenuBuilder.confirmation(confirm, source: item) { [weak self] in
      guard let self, self.openEntryId == entryId else { return }
      self.send(intent)
    }
    // The menu dismisses as the tap lands; the alert waits for it.
    DispatchQueue.main.async {
      presenter.present(alert, animated: true)
    }
  }

  /// Flips the checkmark of `id` in the open menu, which stays on screen.
  private func toggleVisibleCheckmark(of id: String) {
    guard var request = openRequest else { return }
    request.items = request.items.map { Self.toggling(id, in: $0) }
    openRequest = request
    let updated = menu(for: request)
    anchor.menu = updated
    anchor.contextMenuInteraction?.updateVisibleMenu { _ in updated }
  }

  private static func toggling(_ id: String, in item: MenuItem) -> MenuItem {
    switch item {
    case .action(var action):
      if action.id == id { action.checked.toggle() }
      return .action(action)
    case .section(let title, let items):
      return .section(title: title, items: items.map { toggling(id, in: $0) })
    }
  }
}
