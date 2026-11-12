import ChromeKit
import UIKit
import WebKit

/// One page of the native chrome. It holds the web view while its tab is
/// selected, edge to edge, so the system bars float over the page and reach
/// the web layout through the safe area. Its navigation item is the native
/// navigation bar of the page.
@MainActor
final class WebPageController: UIViewController {
  /// The tab of this page.
  let chromeTab: ChromeTab

  /// The bar buttons on screen, so a state with the same buttons keeps the
  /// items, and an open menu stays open.
  private var shownLeading: [BarButton]?
  private var shownTrailing: [BarButton]?
  private var shownCanBack = false
  private var shownTitleMenu: [MenuItem]?
  /// The history entry the bar items send their intents for.
  private var shownEntryId: Int?

  init(tab: ChromeTab) {
    self.chromeTab = tab
    super.init(nibName: nil, bundle: nil)
    navigationItem.largeTitleDisplayMode = .never
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func loadView() {
    let view = UIView()
    view.backgroundColor = .systemBackground
    self.view = view
  }

  /// Whether the web view is in this page.
  func holds(_ webView: WKWebView) -> Bool {
    webView.superview === view
  }

  /// Moves the web view into this page, under every other subview. A web
  /// view that had the focus gets it back, as leaving the window resigns it.
  func attach(_ webView: WKWebView) {
    guard !holds(webView) else { return }
    let focused = Self.holdsFirstResponder(webView)
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.insertSubview(webView, at: 0)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    if focused {
      _ = webView.becomeFirstResponder()
    }
  }

  private static func holdsFirstResponder(_ view: UIView) -> Bool {
    view.isFirstResponder || view.subviews.contains { holdsFirstResponder($0) }
  }

  /// Shows the bar of `state` in the navigation bar of this page. Bar
  /// buttons send `action` intents, menus come from `menus`, and the back
  /// chevron sends `back`.
  func showBar(
    _ state: ChromeState, menus: MenuPresenter, send: @escaping (ChromeIntent) -> Void
  ) {
    navigationController?.setNavigationBarHidden(Self.hidesBar(state), animated: false)
    navigationItem.title = state.title ?? ""
    let entryId = state.entryId
    let newEntry = entryId != shownEntryId
    shownEntryId = entryId

    if newEntry || state.titleMenu != shownTitleMenu {
      shownTitleMenu = state.titleMenu
      navigationItem.titleMenuProvider = state.titleMenu.map { items in
        { [weak menus, weak self] _ in
          menus?.barMenu(items, entryId: entryId) { self?.navigationController?.navigationBar }
        }
      }
    }

    if newEntry || state.leading != shownLeading || state.canBack != shownCanBack {
      let items = (navigationItem.leftBarButtonItems ?? []).dropFirst(state.canBack ? 1 : 0)
      if !newEntry, state.canBack == shownCanBack, let shownLeading,
        Self.differInMenusOnly(state.leading, shownLeading), items.count == state.leading.count
      {
        setMenus(of: Array(items), to: state.leading, entryId: entryId, menus: menus)
      } else {
        var items: [UIBarButtonItem] = []
        if state.canBack {
          let item = UIBarButtonItem(
            image: UIImage(systemName: "chevron.backward"),
            primaryAction: UIAction { _ in send(.back(entryId: entryId)) })
          item.accessibilityLabel = Bundle(for: UIButton.self).localizedString(
            forKey: "Back", value: "Back", table: nil)
          items.append(item)
        }
        items += state.leading.map { barItem($0, entryId: entryId, menus: menus, send: send) }
        navigationItem.leftBarButtonItems = items
      }
      shownLeading = state.leading
      shownCanBack = state.canBack
    }

    if newEntry || state.trailing != shownTrailing {
      let items = navigationItem.rightBarButtonItems ?? []
      if !newEntry, let shownTrailing, Self.differInMenusOnly(state.trailing, shownTrailing),
        items.count == state.trailing.count
      {
        setMenus(of: items, to: state.trailing.reversed(), entryId: entryId, menus: menus)
      } else {
        navigationItem.rightBarButtonItems = state.trailing.reversed().map {
          barItem($0, entryId: entryId, menus: menus, send: send)
        }
      }
      shownTrailing = state.trailing
    }
  }

  /// Only menus changed: the same items take the new menus, so an open menu
  /// stays open and a confirmation keeps its anchor.
  private func setMenus(
    of items: [UIBarButtonItem], to buttons: [BarButton], entryId: Int, menus: MenuPresenter
  ) {
    for (item, button) in zip(items, buttons) {
      if let menu = button.menu {
        item.menu = menus.barMenu(menu, entryId: entryId) { [weak item] in item }
      }
    }
  }

  /// Whether `a` and `b` show the same buttons and differ only in the
  /// items of their menus.
  private static func differInMenusOnly(_ a: [BarButton], _ b: [BarButton]) -> Bool {
    a.count == b.count
      && zip(a, b).allSatisfy { next, shown in
        next.id == shown.id && next.title == shown.title && next.icon == shown.icon
          && (next.menu == nil) == (shown.menu == nil)
      }
  }

  /// Whether `state` hides the navigation bar.
  static func hidesBar(_ state: ChromeState) -> Bool {
    state.chrome == .none || !state.showsBar
  }

  /// Whether showing `state` would show or hide the navigation bar.
  func barVisibilityChanges(for state: ChromeState) -> Bool {
    (navigationController?.isNavigationBarHidden ?? true) != Self.hidesBar(state)
  }

  /// Hides the navigation bar and forgets its items, so nothing of an old
  /// document stays on screen.
  func clearBar() {
    navigationController?.setNavigationBarHidden(true, animated: false)
    navigationItem.title = nil
    navigationItem.titleMenuProvider = nil
    navigationItem.leftBarButtonItems = nil
    navigationItem.rightBarButtonItems = nil
    shownLeading = nil
    shownTrailing = nil
    shownCanBack = false
    shownTitleMenu = nil
    shownEntryId = nil
    setBarDimmed(false)
  }

  /// Dims the navigation bar and ignores its touches while a web drawer is
  /// open, as the system bars do behind a sheet.
  func setBarDimmed(_ dimmed: Bool) {
    guard let bar = navigationController?.navigationBar else { return }
    bar.isUserInteractionEnabled = !dimmed
    bar.tintAdjustmentMode = dimmed ? .dimmed : .automatic
  }

  private func barItem(
    _ button: BarButton, entryId: Int, menus: MenuPresenter,
    send: @escaping (ChromeIntent) -> Void
  ) -> UIBarButtonItem {
    let item: UIBarButtonItem
    if let menu = button.menu {
      item = UIBarButtonItem(title: button.title, image: nil, primaryAction: nil, menu: nil)
      item.menu = menus.barMenu(menu, entryId: entryId) { [weak item] in item }
    } else {
      item = UIBarButtonItem(
        title: button.title, image: nil,
        primaryAction: UIAction { _ in send(.action(entryId: entryId, id: button.id)) })
    }
    item.image = button.icon.flatMap { UIImage(systemName: $0) }
    item.accessibilityLabel = button.title
    return item
  }
}
