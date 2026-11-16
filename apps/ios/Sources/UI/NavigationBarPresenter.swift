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
  /// Set while the shell itself changes the field, so the change is not sent.
  private var writingSearch = false
  /// A focus request for an entry the bar does not show yet.
  private var pendingFocus: Int?

  private lazy var titleButton: UIButton = {
    var configuration = UIButton.Configuration.plain()
    configuration.image = UIImage(systemName: "chevron.down")
    configuration.imagePlacement = .trailing
    configuration.imagePadding = 4
    configuration.preferredSymbolConfigurationForImage = .init(textStyle: .footnote, scale: .small)
    configuration.baseForegroundColor = .label
    configuration.titleLineBreakMode = .byTruncatingTail
    let button = UIButton(configuration: configuration)
    button.accessibilityHint = "Change month"
    button.addAction(
      UIAction { [weak self] _ in
        guard let self, let monthTitle = self.monthTitle else { return }
        self.pickMonth(monthTitle.month, self.titleButton)
      }, for: .primaryActionTriggered)
    return button
  }()

  private lazy var textTitle: UILabel = {
    let label = UILabel()
    label.font = .preferredFont(forTextStyle: .headline)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .label
    label.lineBreakMode = .byTruncatingTail
    label.accessibilityTraits = .header
    return label
  }()

  /// The integrated search field.
  private lazy var search = makeSearch()

  /// The search field of a row with no title and no leading button, in the
  /// title view: UIKit keeps the leading part of the row for a title, so the
  /// integrated field would leave it empty. A field of its own, because the
  /// integrated placement changes the look of its field.
  private lazy var rowSearch: UISearchController = {
    let search = makeSearch()
    searchBox.addSubview(search.searchBar)
    return search
  }()

  /// Holds the field of `rowSearch`: a search bar that is the title view
  /// itself sits lower than the bar buttons. The box has the height of the
  /// field, so every tap on the field lands in the box.
  private let searchBox = SearchBox(frame: CGRect(x: 0, y: 0, width: 1000, height: 44))

  /// Whether the bar shows `rowSearch` instead of `search`.
  private var searchFillsRow = false
  private var shownSearch: UISearchController { searchFillsRow ? rowSearch : search }

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
    let next = Shown(state)
    let fillsRow =
      state.search != nil && state.title == nil && next.back == .none && next.leading.isEmpty
    if newEntry || fillsRow != searchFillsRow {
      endSearch()
    }
    if fillsRow != searchFillsRow {
      // The other field has none of the text yet.
      searchRevision = nil
      searchFillsRow = fillsRow
    }
    if fillsRow {
      item.searchController = nil
    }
    // The title lays out before the buttons animate, so it does not move
    // in from the corner of its frame.
    var titleChanged = false
    UIView.performWithoutAnimation {
      titleChanged = showTitle(state.title)
      bar.layoutIfNeeded()
    }
    if animated, titleChanged, let titleView = item.titleView {
      let alpha = titleView.alpha
      titleView.alpha = 0
      UIView.animate(withDuration: 0.25) { titleView.alpha = alpha }
    }
    showButtons(next, newEntry: newEntry, animated: animated)
    showSearch(state.search, newEntry: newEntry)
    if let pendingFocus, pendingFocus == entryId {
      self.pendingFocus = nil
      // The search bar joins the window in the next layout pass.
      DispatchQueue.main.async { [weak self] in self?.focusSearch(entryId: pendingFocus) }
    }
  }

  /// Runs `change` without sending the field's updates to the page.
  private func writeSearch(_ change: () -> Void) {
    writingSearch = true
    change()
    writingSearch = false
  }

  /// Shows `title` in its title view, or the field of `rowSearch` when it
  /// fills the row. Returns whether the bar shows a different title view now.
  private func showTitle(_ title: ChromeTitle?) -> Bool {
    let shownView = item.titleView
    let shownText = (shownView as? UILabel)?.text ?? monthTitle?.text
    switch title {
    case .month(let month):
      monthTitle = (month.text, month.month)
      if titleButton.accessibilityLabel != month.text {
        titleButton.configuration?.attributedTitle = AttributedString(
          month.text,
          attributes: AttributeContainer([.font: UIFont.preferredFont(forTextStyle: .headline)]))
        titleButton.accessibilityLabel = month.text
        // The bar keeps a title view's frame: a longer month needs a wider one.
        titleButton.sizeToFit()
      }
      item.titleView = titleButton
      return shownView !== titleButton || shownText != month.text
    case .text(let text):
      monthTitle = nil
      if textTitle.text != text.text {
        textTitle.text = text.text
        textTitle.sizeToFit()
      }
      item.titleView = textTitle
      return shownView !== textTitle || shownText != text.text
    case nil:
      monthTitle = nil
      let view = searchFillsRow ? rowSearch.searchBar.superview : nil
      item.titleView = view
      return shownView !== view
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
      endSearch()
      item.searchController = nil
      searchRevision = nil
      return
    }
    if !searchFillsRow, item.searchController !== search {
      item.searchController = search
    }
    let searchBar = shownSearch.searchBar
    searchBar.placeholder = state.placeholder
    searchBar.searchTextField.accessibilityLabel = state.label
    let revision = (entryId: entryId, revision: state.revision)
    if searchRevision?.entryId != revision.entryId || searchRevision?.revision != revision.revision
    {
      searchRevision = revision
      sentText = state.text
      writeSearch { searchBar.text = state.text }
    }
  }

  private func makeSearch() -> UISearchController {
    let search = UISearchController(searchResultsController: nil)
    search.obscuresBackgroundDuringPresentation = false
    search.hidesNavigationBarDuringPresentation = false
    search.searchResultsUpdater = self
    search.searchBar.delegate = self
    return search
  }

  /// Ends the search in the shown field and lowers its keyboard.
  private func endSearch() {
    if shownSearch.isActive {
      writeSearch { shownSearch.isActive = false }
    }
  }

  /// Focuses the search field of `entryId` and selects its text. A request
  /// for an entry that is not shown yet waits for that entry.
  func focusSearch(entryId: Int) {
    guard entryId == self.entryId else {
      pendingFocus = entryId
      return
    }
    guard item.searchController === search || item.titleView === searchBox else { return }
    let field = shownSearch.searchBar.searchTextField
    field.becomeFirstResponder()
    field.selectAll(nil)
  }

  func updateSearchResults(for searchController: UISearchController) {
    guard searchController === shownSearch else { return }
    let text = searchController.searchBar.text ?? ""
    guard !writingSearch, text != sentText else { return }
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

  /// A new document: nothing of the old page stays in the bar. The empty bar
  /// stays, so the page loads with the safe area of the shell.
  func reset() {
    shown = nil
    entryId = -1
    searchRevision = nil
    sentText = nil
    pendingFocus = nil
    endSearch()
    searchFillsRow = false
    item.searchController = nil
    item.titleView = nil
    item.setLeftBarButtonItems(nil, animated: false)
    item.setRightBarButtonItems(nil, animated: false)
    setDimmed(false)
    setFaded(false, animated: false)
    navigation.setNavigationBarHidden(false, animated: false)
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

/// Keeps its subview at its own size. An active search controller lays its
/// field out again at the width of the screen, so the box sets it back.
private final class SearchBox: UIView {
  override func layoutSubviews() {
    super.layoutSubviews()
    for view in subviews {
      view.frame = bounds
    }
  }
}
