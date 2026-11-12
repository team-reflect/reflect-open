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
  /// The open confirmation.
  private weak var confirmation: UIAlertController?

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

  /// The menu of a bar button or title: its taps send `action` intents for
  /// `entryId`, and a confirmation opens from `source`.
  func barMenu(
    _ items: [MenuItem], entryId: Int,
    source: @escaping () -> (any UIPopoverPresentationControllerSourceItem)?
  ) -> UIMenu {
    MenuBuilder.menu(items) { [weak self] action in
      guard let self else { return }
      // The next state rebuilds a bar menu with the new checkmarks.
      self.select(
        action, intent: .action(entryId: entryId, id: action.id), entryId: entryId, source: source)
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
    confirmation?.dismiss(animated: true)
  }

  private func menu(for request: MenuRequest) -> UIMenu {
    MenuBuilder.menu(request.items) { [weak self] action in
      guard let self else { return }
      if action.keepsMenuPresented {
        self.toggleVisibleCheckmark(of: action.id)
      }
      self.select(
        action, intent: .menu(entryId: request.entryId, menuId: request.menuId, id: action.id),
        entryId: request.entryId
      ) { [weak self] in self?.anchor }
    }
  }

  /// Sends the intent of `action`, after a confirmation when it has one.
  private func select(
    _ action: MenuAction, intent: ChromeIntent, entryId: Int,
    source: @escaping () -> (any UIPopoverPresentationControllerSourceItem)?
  ) {
    guard let confirm = action.confirm else {
      send(intent)
      return
    }
    guard let presenter = presenter() else { return }
    guard let item = source() ?? presenter.viewIfLoaded else { return }
    openEntryId = entryId
    let alert = MenuBuilder.confirmation(confirm, source: item) { [weak self] in
      guard let self, self.openEntryId == entryId else { return }
      self.send(intent)
    }
    confirmation = alert
    // The menu dismisses as the tap lands; the alert waits for it, and for
    // an earlier alert that still closes, and shows only while the page
    // still shows its entry.
    DispatchQueue.main.async { [weak self] in
      let present = { [weak self] in
        guard self?.openEntryId == entryId else { return }
        presenter.present(alert, animated: true)
      }
      if let closing = presenter.presentedViewController, closing.isBeingDismissed,
        let coordinator = closing.transitionCoordinator
      {
        coordinator.animate(alongsideTransition: nil) { _ in present() }
      } else {
        present()
      }
    }
  }

  /// Flips the checkmark of `id` in the open `presentMenu` menu, which stays
  /// on screen.
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
