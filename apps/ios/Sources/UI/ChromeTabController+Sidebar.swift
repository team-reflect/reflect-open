import ChromeKit
import TypesShared
import UIKit

/// The identifiers of the sidebar's rows beyond the three tabs.
enum SidebarRow {
  static let chat = "chat"
  static let pinnedGroup = "pinned"
  /// Before a pinned note's path in the identifier of its row.
  static let pinnedPrefix = "pinned:"

  /// The intent of a tap on `tab`, or `nil` for a row that sends none.
  static func intent(for tab: UITab) -> SidebarIntent? {
    if tab is UISearchTab { return .search }
    if tab.identifier == chat { return .chat }
    if tab.identifier.hasPrefix(pinnedPrefix) {
      return .openNote(.init(path: path(of: tab.identifier)))
    }
    return nil
  }

  /// The note path of a pinned row's identifier.
  static func path(of identifier: String) -> String {
    String(identifier.dropFirst(pinnedPrefix.count))
  }
}

/// The iPad sidebar: Search above the tabs, then Chat, the pinned notes, and
/// the graph and Settings at the bottom. Chat also shows in the top tab bar.
/// The page sends what it shows and runs every tap.
extension ChromeTabController: UITabBarController.Sidebar.Delegate {
  /// The tabs from `main` with Search, Chat, and the pinned notes around them.
  func makeSidebarTabs(main: () -> [UITab]) -> [UITab] {
    let search = UISearchTab { _ in TabPlaceholder() }
    let chat = makeTab(
      identifier: SidebarRow.chat, title: "Chat", image: UIImage(systemName: "bubble.left"))
    for tab in [search, pinnedGroup] {
      tab.preferredPlacement = .sidebarOnly
    }
    // A fixed tab leaves the sidebar without an Edit button.
    chat.preferredPlacement = .fixed
    pinnedGroup.isHidden = true
    footer.isHidden = true
    pinnedPlaceholder.onLayout = { [weak self] in
      guard let self, self.selectedTab?.parent === self.pinnedGroup else { return }
      self.placeStage()
    }
    footer.onMenu = { [weak self] id in self?.send(.sidebar(.init(command: .menu(.init(id: id))))) }
    footer.onSettings = { [weak self] in self?.send(.sidebar(.init(command: .settings))) }
    return [search] + main() + [chat, pinnedGroup]
  }

  /// The row of a pinned note, which stays in the sidebar.
  private func makePinnedTab(identifier: String, title: String) -> UITab {
    let tab = makeTab(identifier: identifier, title: title, image: nil)
    tab.preferredPlacement = .sidebarOnly
    return tab
  }

  /// The top-level tab or the pinned row with `identifier`.
  func tab(for identifier: String) -> UITab? {
    tabs.first { $0.identifier == identifier } ?? pinnedGroup.tab(forIdentifier: identifier)
  }

  /// Whether the sidebar shows.
  var sidebarVisible: Bool {
    mode == .tabSidebar && !sidebar.isHidden && traitCollection.horizontalSizeClass == .regular
  }

  /// Shows the pinned notes and the graph of `state`, in the page's order.
  func updateSidebar(_ state: SidebarState?) {
    guard state != sidebarState else { return }
    sidebarState = state
    // A screen without chrome leaves the sidebar with its rows only.
    footer.isHidden = state == nil
    guard let state else {
      updateSidebarRows()
      return
    }
    footer.update(state)
    let ids = state.pinned.map { SidebarRow.pinnedPrefix + $0.path }
    if pinnedGroup.children.map(\.identifier) != ids {
      let old = Dictionary(uniqueKeysWithValues: pinnedGroup.children.map { ($0.identifier, $0) })
      pinnedGroup.children = zip(ids, state.pinned).map { id, note in
        old[id] ?? makePinnedTab(identifier: id, title: note.title)
      }
      for id in old.keys where !ids.contains(id) {
        placeholders[id] = nil
      }
    }
    for (tab, note) in zip(pinnedGroup.children, state.pinned) where tab.title != note.title {
      tab.title = note.title
      sidebar.reconfigureItem(for: tab)
    }
    updateSidebarRows()
  }

  /// Shows the sidebar-only rows only in the sidebar: the tab bar keeps a
  /// search tab, and the last sidebar-only tab selected, whatever their
  /// placement. Chat shows in the tab bar too, so only the bottom tab bar
  /// hides it.
  func updateSidebarRows() {
    let hidden = mode != .tabSidebar || sidebar.isHidden
    for tab in tabs where tab is UISearchTab {
      tab.isHidden = hidden
    }
    for tab in tabs where tab.identifier == SidebarRow.chat {
      tab.isHidden = mode != .tabSidebar
    }
    pinnedGroup.isHidden = hidden || sidebarState?.pinned.isEmpty != false
    for tab in pinnedGroup.children {
      tab.isHidden = hidden
    }
  }

  /// Tells the page whether the sidebar shows (`nil` without a sidebar), and
  /// selects the row or the tab of the last state.
  func reportSidebarVisible() {
    updateSidebarRows()
    let visible = mode == .tabSidebar ? sidebarVisible : nil
    guard visible != reportedSidebarVisible else { return }
    reportedSidebarVisible = visible
    onSidebarVisible(visible)
    if let shownTab {
      follow(shownTab)
    }
  }

  func tabBarController(
    _ tabBarController: UITabBarController,
    sidebarVisibilityWillChange sidebar: UITabBarController.Sidebar,
    animator: any UITabBarController.Sidebar.Animating
  ) {
    if !settingSidebar {
      userToggledSidebar = true
    }
    updateSidebarRows()
    animator.addCompletion { [weak self] in self?.reportSidebarVisible() }
  }

  func tabBarController(
    _ tabBarController: UITabBarController, sidebar: UITabBarController.Sidebar,
    contextMenuConfigurationFor tab: UITab
  ) -> UIContextMenuConfiguration? {
    guard tab.identifier.hasPrefix(SidebarRow.pinnedPrefix) else { return nil }
    let path = SidebarRow.path(of: tab.identifier)
    // Share reads the open editor's buffer, so it is for the note on screen.
    let open = sidebarState?.selection == tab.identifier
    return UIContextMenuConfiguration(actionProvider: { [weak self] _ in
      let share = UIAction(title: "Share…", image: UIImage(systemName: "square.and.arrow.up")) {
        _ in self?.send(.sidebar(.init(command: .share(.init(path: path)))))
      }
      let unpin = UIAction(title: "Unpin", image: UIImage(systemName: "pin.slash")) { _ in
        self?.send(.sidebar(.init(command: .unpin(.init(path: path)))))
      }
      return UIMenu(children: open ? [share, unpin] : [unpin])
    })
  }
}
