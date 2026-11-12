#if canImport(UIKit)
public import UIKit

/// Builds `UIMenu`s and confirmations from the page's menu items.
@MainActor
public enum MenuBuilder {
  /// A menu of `items`. A tap on an action calls `onSelect` with it.
  public static func menu(
    _ items: [MenuItem], onSelect: @escaping @MainActor (MenuAction) -> Void
  ) -> UIMenu {
    UIMenu(children: elements(items, onSelect: onSelect))
  }

  /// The menu elements of `items`: a section is an inline submenu.
  private static func elements(
    _ items: [MenuItem], onSelect: @escaping @MainActor (MenuAction) -> Void
  ) -> [UIMenuElement] {
    items.map { item in
      switch item {
      case .section(let title, let items):
        return UIMenu(
          title: title ?? "", options: .displayInline,
          children: elements(items, onSelect: onSelect))
      case .action(let action):
        var attributes: UIMenuElement.Attributes = []
        if action.destructive { attributes.insert(.destructive) }
        if action.disabled { attributes.insert(.disabled) }
        if action.keepsMenuPresented { attributes.insert(.keepsMenuPresented) }
        return UIAction(
          title: action.title,
          image: action.icon.flatMap { UIImage(systemName: $0) },
          attributes: attributes,
          state: action.checked ? .on : .off
        ) { _ in
          onSelect(action)
        }
      }
    }
  }

  /// An action sheet that asks before a destructive action. On iPad it is a
  /// popover at `source`.
  public static func confirmation(
    _ confirm: MenuConfirm, source: any UIPopoverPresentationControllerSourceItem,
    onConfirm: @escaping @MainActor () -> Void
  ) -> UIAlertController {
    let alert = UIAlertController(
      title: confirm.title, message: confirm.message, preferredStyle: .actionSheet)
    alert.addAction(
      UIAlertAction(title: confirm.action, style: .destructive) { _ in
        onConfirm()
      })
    alert.addAction(UIAlertAction(title: cancelTitle, style: .cancel))
    alert.popoverPresentationController?.sourceItem = source
    return alert
  }

  /// The system's own "Cancel", in the user's language.
  private static var cancelTitle: String {
    Bundle(for: UIButton.self).localizedString(forKey: "Cancel", value: "Cancel", table: nil)
  }
}
#endif
