public import TypesShared

/// Which tab the native tab bar shows. A tap selects its tab at once and
/// sends it to the page. States posted before the tap still name the old tab,
/// so they must not move the selection back until the page shows the tapped
/// tab, or until the tap times out.
public struct TabFollow: Equatable, Sendable {
  /// The tab the user tapped, until the page shows it.
  public private(set) var pendingTab: ChromeTab?
  /// The tab of the last state.
  public private(set) var stateTab: ChromeTab?

  public init() {}

  /// The user tapped `tab`, which is not the selected tab.
  public mutating func tap(_ tab: ChromeTab) {
    pendingTab = tab
  }

  /// A state names `tab`. Returns the tab to select, or `nil` while a tap
  /// waits for the page.
  public mutating func state(_ tab: ChromeTab) -> ChromeTab? {
    stateTab = tab
    if pendingTab == tab {
      pendingTab = nil
    }
    return pendingTab == nil ? tab : nil
  }

  /// The tap on `tab` timed out. Returns the tab of the last state when the
  /// page never showed `tab`, else `nil`.
  public mutating func timeOut(_ tab: ChromeTab) -> ChromeTab? {
    guard pendingTab == tab else { return nil }
    pendingTab = nil
    return stateTab
  }
}
