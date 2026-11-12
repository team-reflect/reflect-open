import ChromeKit
import UIKit

/// Builds the menus of the corner buttons as `UIMenu`s and asks before
/// destructive items. A confirmation that is still open when the page moves
/// to another history entry closes, and its tap never reaches the new page.
@MainActor
final class MenuPresenter {
  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }
  /// The controller that presents confirmations.
  var presenter: () -> UIViewController? = { nil }

  /// The history entry of the open confirmation.
  private var openEntryId: Int?
  /// The open confirmation.
  private weak var confirmation: UIAlertController?

  /// The menu of a corner button: its taps send `action` intents for
  /// `entryId`, and a confirmation opens from `source`.
  func barMenu(
    _ items: [MenuItem], entryId: Int,
    source: @escaping () -> (any UIPopoverPresentationControllerSourceItem)?
  ) -> UIMenu {
    MenuBuilder.menu(items) { [weak self] action in
      guard let self else { return }
      // The next state rebuilds a button's menu with the new checkmarks.
      self.select(
        action, intent: .action(entryId: entryId, id: action.id), entryId: entryId, source: source)
    }
  }

  /// The page shows `entryId`: closes a confirmation of another entry.
  func pageDidShow(entryId: Int) {
    guard let openEntryId, openEntryId != entryId else { return }
    closeAll()
  }

  /// Closes the open confirmation.
  func closeAll() {
    openEntryId = nil
    confirmation?.dismiss(animated: true)
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
}
