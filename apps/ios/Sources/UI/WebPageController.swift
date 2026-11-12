import ChromeKit
import UIKit
import WebKit

/// One page of the native chrome. It holds the web view while its tab is
/// selected, edge to edge, so the system bars float over the page and reach
/// the web layout through the safe area. Its navigation item is the native
/// navigation bar of the page.
@MainActor
final class WebPageController: UIViewController {
  /// The tab of this page, or `nil` for the page of a build without a tab bar.
  let chromeTab: ChromeTab?

  /// The bar buttons on screen, so a state with the same buttons keeps the
  /// items, and an open menu stays open.
  private var shownLeading: [BarButton]?
  private var shownTrailing: [BarButton]?
  private var shownCanBack = false
  private var shownTitleMenu: [MenuItem]?
  /// The history entry the bar items send their intents for.
  private var shownEntryId: Int?

  init(tab: ChromeTab?) {
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

  /// Moves the web view into this page, under every other subview.
  func attach(_ webView: WKWebView) {
    guard !holds(webView) else { return }
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.insertSubview(webView, at: 0)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  /// Shows the bar of `state` in the navigation bar of this page. Bar
  /// buttons send `action` intents, menus come from `menus`, and the back
  /// chevron sends `back`.
  func showBar(
    _ state: ChromeState, menus: MenuPresenter, send: @escaping (ChromeIntent) -> Void
  ) {
    navigationController?.setNavigationBarHidden(
      state.chrome == .none || !state.showsBar, animated: false)
    navigationItem.title = state.title ?? ""
    let entryId = state.entryId
    let newEntry = entryId != shownEntryId
    shownEntryId = entryId

    if newEntry || state.titleMenu != shownTitleMenu {
      shownTitleMenu = state.titleMenu
      navigationItem.titleMenuProvider = state.titleMenu.map { items in
        { [weak menus] _ in
          menus?.barMenu(items, entryId: entryId, source: { nil })
        }
      }
    }

    if newEntry || state.leading != shownLeading || state.canBack != shownCanBack {
      shownLeading = state.leading
      shownCanBack = state.canBack
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

    if newEntry || state.trailing != shownTrailing {
      shownTrailing = state.trailing
      navigationItem.rightBarButtonItems = state.trailing.reversed().map {
        barItem($0, entryId: entryId, menus: menus, send: send)
      }
    }
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
