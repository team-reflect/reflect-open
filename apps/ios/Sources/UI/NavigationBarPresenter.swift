import ChromeKit
import TypesShared
import UIKit

/// Shows the top bar of each chrome state in the navigation bar of the
/// stage: the title, the bar buttons, and the search field.
@MainActor
final class NavigationBarPresenter: NSObject, UISearchResultsUpdating, UISearchBarDelegate {
  /// Sends an intent after the web view takes the focus.
  var send: (ChromeIntent) -> Void = { _ in }
  /// Sends an intent and leaves the focus where it is, so the search field
  /// keeps the keyboard.
  var sendKeepingFocus: (ChromeIntent) -> Void = { _ in }
  /// Opens the month picker for `month` from the title button.
  var pickMonth: (_ month: String, _ source: UIView) -> Void = { _, _ in }

  private let navigation: UINavigationController
  private let menus: MenuPresenter
  private var item: UINavigationItem { navigation.viewControllers[0].navigationItem }
  private var bar: UINavigationBar { navigation.navigationBar }

  /// What the bar shows now, so an equal state changes nothing and an open
  /// menu stays open.
  private var shown: Shown?
  private var entryId = -1
  private var monthTitle: (text: String, month: String)?
  /// The revision of the search text written into the field, per entry.
  private var searchRevision: (entryId: Int, revision: Int)?
  /// The last text sent to the page, so the field's own updates send once.
  private var sentText: String?

  private lazy var titleButton: UIButton = {
    var configuration = UIButton.Configuration.plain()
    configuration.image = UIImage(systemName: "chevron.down")
    configuration.imagePlacement = .trailing
    configuration.imagePadding = 4
    configuration.preferredSymbolConfigurationForImage = .init(textStyle: .footnote, scale: .small)
    configuration.baseForegroundColor = .label
    let button = UIButton(configuration: configuration)
    button.accessibilityHint = "Change month"
    button.addAction(
      UIAction { [weak self] _ in
        guard let self, let monthTitle = self.monthTitle else { return }
        self.pickMonth(monthTitle.month, self.titleButton)
      }, for: .primaryActionTriggered)
    return button
  }()

  private lazy var search: UISearchController = {
    let search = UISearchController(searchResultsController: nil)
    search.obscuresBackgroundDuringPresentation = false
    search.hidesNavigationBarDuringPresentation = false
    search.searchResultsUpdater = self
    search.searchBar.delegate = self
    return search
  }()

  init(navigation: UINavigationController, menus: MenuPresenter) {
    self.navigation = navigation
    self.menus = menus
    super.init()
    // The web view lies under the bar and paints its background.
    let appearance = UINavigationBarAppearance()
    appearance.configureWithTransparentBackground()
    bar.standardAppearance = appearance
    bar.scrollEdgeAppearance = appearance
    bar.compactAppearance = appearance
    item.hidesSearchBarWhenScrolling = false
    if #available(iOS 26, *) {
      item.preferredSearchBarPlacement = .integrated
      item.searchBarPlacementAllowsToolbarIntegration = false
    } else {
      item.preferredSearchBarPlacement = .inline
    }
  }

  /// Shows the top bar of `state`. With `animated`, UIKit animates the
  /// buttons that change.
  func show(_ state: ChromeState, animated: Bool) {
    navigation.setNavigationBarHidden(
      state.chrome == .none || state.fullscreen, animated: animated)
    let newEntry = state.entryId != entryId
    entryId = state.entryId
    showTitle(state.title)
    showButtons(Shown(state), newEntry: newEntry, animated: animated)
    showSearch(state.search, newEntry: newEntry)
  }

  private func showTitle(_ title: ChromeTitle?) {
    switch title {
    case .month(let month):
      monthTitle = (month.text, month.month)
      if titleButton.accessibilityLabel != month.text {
        titleButton.configuration?.attributedTitle = AttributedString(
          month.text,
          attributes: AttributeContainer([.font: UIFont.preferredFont(forTextStyle: .headline)]))
        titleButton.accessibilityLabel = month.text
      }
      item.title = nil
      item.titleView = titleButton
    case .text(let text):
      monthTitle = nil
      item.titleView = nil
      item.title = text.text
    case nil:
      monthTitle = nil
      item.titleView = nil
      item.title = nil
    }
  }

  private func showButtons(_ next: Shown, newEntry: Bool, animated: Bool) {
    if !newEntry, shown == next { return }
    if !newEntry, let current = shown, current.differsInMenusOnly(from: next) {
      // Same buttons: only the menus change, so an open menu stays open.
      updateMenus(next)
      shown = next
      return
    }
    item.setLeftBarButtonItems(leadingItems(next), animated: animated)
    // The last item sits at the trailing edge.
    item.setRightBarButtonItems(next.trailing.reversed().map(barItem), animated: animated)
    shown = next
  }

  /// The back arrow, or the history arrows (one shared capsule on iOS 26),
  /// then the screen's leading buttons in a capsule of their own.
  private func leadingItems(_ next: Shown) -> [UIBarButtonItem] {
    var items: [UIBarButtonItem] = []
    let entryId = entryId
    switch next.back {
    case .none:
      break
    case .back:
      items.append(arrow(forward: false) { .back(.init(entryId: entryId)) })
    case .history(let history):
      let back = arrow(forward: false) { .history(.init(entryId: entryId, direction: .back)) }
      back.isEnabled = history.back
      let forward = arrow(forward: true) {
        .history(.init(entryId: entryId, direction: .forward))
      }
      forward.isEnabled = history.forward
      items += [back, forward]
    }
    if !items.isEmpty, !next.leading.isEmpty {
      items.append(.fixedSpace(0))
    }
    return items + next.leading.map(barItem)
  }

  private func arrow(forward: Bool, intent: @escaping () -> ChromeIntent) -> UIBarButtonItem {
    let name = forward ? "Forward" : "Back"
    let item = UIBarButtonItem(
      image: UIImage(systemName: forward ? "chevron.forward" : "chevron.backward"),
      primaryAction: UIAction { [weak self] _ in self?.send(intent()) })
    item.accessibilityLabel =
      Bundle(for: UIButton.self).localizedString(forKey: name, value: name, table: nil)
    return item
  }

  private func barItem(_ button: BarButton) -> UIBarButtonItem {
    let image = button.icon.flatMap { UIImage(systemName: $0) }
    let entryId = entryId
    let barItem = UIBarButtonItem(title: image == nil ? button.title : nil, image: image)
    if let menu = button.menu {
      // The confirmation of a menu item opens from this item.
      barItem.menu = menus.barMenu(menu, entryId: entryId) { [weak barItem] in barItem }
    } else {
      barItem.primaryAction = UIAction(title: button.title, image: image) { [weak self] _ in
        self?.send(.action(.init(entryId: entryId, id: button.id)))
      }
    }
    barItem.accessibilityLabel = button.title
    return barItem
  }

  private func updateMenus(_ next: Shown) {
    let items =
      (item.leftBarButtonItems ?? []).filter { $0.menu != nil }
      + (item.rightBarButtonItems ?? []).reversed().filter { $0.menu != nil }
    let menus = (next.leading + next.trailing).compactMap(\.menu)
    for (barItem, menu) in zip(items, menus) {
      barItem.menu = self.menus.barMenu(menu, entryId: entryId) { [weak barItem] in barItem }
    }
  }

  private func showSearch(_ state: SearchState?, newEntry: Bool) {
    guard let state else {
      if item.searchController != nil {
        search.isActive = false
        item.searchController = nil
      }
      searchRevision = nil
      return
    }
    if newEntry, search.isActive {
      search.isActive = false
    }
    if item.searchController !== search {
      item.searchController = search
    }
    search.searchBar.placeholder = state.placeholder
    search.searchBar.searchTextField.accessibilityLabel = state.label
    let revision = (entryId: entryId, revision: state.revision)
    if searchRevision?.entryId != revision.entryId || searchRevision?.revision != revision.revision
    {
      searchRevision = revision
      sentText = state.text
      search.searchBar.text = state.text
    }
  }

  /// Focuses the search field of `entryId` and selects its text.
  func focusSearch(entryId: Int) {
    guard entryId == self.entryId, item.searchController === search else { return }
    let field = search.searchBar.searchTextField
    field.becomeFirstResponder()
    field.selectAll(nil)
  }

  func updateSearchResults(for searchController: UISearchController) {
    let text = searchController.searchBar.text ?? ""
    guard text != sentText else { return }
    sentText = text
    sendKeepingFocus(.search(.init(entryId: entryId, text: text)))
  }

  /// Return lowers the keyboard: the lists filter as the user types.
  func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
    searchBar.resignFirstResponder()
  }

  /// Dims the bar and ignores its touches while a web drawer is open.
  func setDimmed(_ dimmed: Bool) {
    bar.isUserInteractionEnabled = !dimmed
    bar.tintAdjustmentMode = dimmed ? .dimmed : .automatic
    titleButton.alpha = dimmed ? 0.4 : 1
  }

  /// Fades the bar's content out or back in, as a back swipe drags the page.
  func setFaded(_ faded: Bool, animated: Bool) {
    let alpha: CGFloat = faded ? 0 : 1
    guard animated else {
      bar.alpha = alpha
      return
    }
    UIView.animate(withDuration: 0.15, delay: 0, options: .beginFromCurrentState) {
      self.bar.alpha = alpha
    }
  }

  /// A new document: nothing of the old page stays in the bar.
  func reset() {
    shown = nil
    entryId = -1
    searchRevision = nil
    sentText = nil
    search.isActive = false
    item.searchController = nil
    item.title = nil
    item.titleView = nil
    item.setLeftBarButtonItems(nil, animated: false)
    item.setRightBarButtonItems(nil, animated: false)
    setDimmed(false)
    setFaded(false, animated: false)
    navigation.setNavigationBarHidden(true, animated: false)
  }
}

/// The buttons of one state, compared to skip equal states.
private struct Shown: Equatable {
  enum Back: Equatable {
    case none
    case back
    case history(HistoryState)
  }

  let back: Back
  let leading: [BarButton]
  let trailing: [BarButton]

  init(_ state: ChromeState) {
    back = state.history.map { .history($0) } ?? (state.canBack ? .back : .none)
    leading = state.leading
    trailing = state.trailing
  }

  /// Whether `next` shows the same buttons, with other menu items.
  func differsInMenusOnly(from next: Shown) -> Bool {
    back == next.back
      && Self.sameFaces(leading, next.leading) && Self.sameFaces(trailing, next.trailing)
  }

  private static func sameFaces(_ a: [BarButton], _ b: [BarButton]) -> Bool {
    a.count == b.count
      && zip(a, b).allSatisfy { a, b in
        a.id == b.id && a.title == b.title && a.icon == b.icon && (a.menu == nil) == (b.menu == nil)
      }
  }
}
