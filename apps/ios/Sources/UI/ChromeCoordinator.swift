import ChromeKit
import TypesShared
import UIKit
import os

/// Connects the page's chrome state to the native containers: it puts the
/// web view in a page, follows the page's theme, and shows what each state
/// asks for.
@MainActor
final class ChromeCoordinator {
  private static let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "app.reflect.ios", category: "chrome")

  private let host: AppHost
  /// The native tab bar.
  private let tabs: ChromeTabController
  /// The container of the pages: the root's only child.
  var container: UIViewController { tabs }
  private let menus = MenuPresenter()
  private let bar: NavigationBarPresenter
  private let monthPicker = MonthPickerPresenter()
  private let formatting: FormattingAccessory
  /// The tab of the last shell state: the bar animates only within one tab.
  /// A state without chrome (the loading screen) shows no tab.
  private var shownTab: ChromeTab?
  /// The entry a back swipe faded the bar for.
  private var swipeEntryId: Int?

  init(host: AppHost) {
    self.host = host
    tabs = ChromeTabController(webView: host.webView)
    bar = NavigationBarPresenter(navigation: tabs.navigation, menus: menus)
    formatting = FormattingAccessory(webView: host.webView)

    let bridge = host.chrome
    menus.send = { [weak self] intent in self?.send(intent) }
    tabs.send = { [weak self] intent in self?.send(intent) }
    bar.send = { [weak self] intent in self?.send(intent) }
    bar.sendKeepingFocus = { [bridge] intent in bridge.send(intent) }
    bar.pickMonth = { [weak self] month, source in self?.presentMonthPicker(month, from: source) }
    monthPicker.onPick = { [weak self] month, entryId in
      self?.send(.pickMonth(.init(entryId: entryId, month: month)))
    }
    tabs.onSidebarVisible = { [bridge] visible in bridge.sidebarVisible = visible }
    tabs.onWindowControlsWidth = { [bridge] width in bridge.windowControlsWidth = width }
    menus.presenter = { [weak self] in self?.container }
    formatting.send = { [weak self] intent in self?.send(intent) }
    formatting.presenter = { [weak self] in self?.container }
    bridge.onState = { [weak self] state in self?.apply(state) }
    bridge.onReset = { [weak self] in self?.reset() }
    bridge.onBackSwipe = { [weak self] started in self?.backSwipe(started: started) }
    bridge.onFocusSearch = { [weak self] entryId in self?.bar.focusSearch(entryId: entryId) }
    bridge.onError = { message in Self.logger.error("\(message, privacy: .public)") }
  }

  private func apply(_ state: ChromeState) {
    #if DEBUG
    Self.logger.debug(
      "state \(state.generation) entry \(state.entryId) \(state.routeKind ?? "none", privacy: .public)"
    )
    #endif
    applyTheme(state.theme)
    tabs.apply(state)
    bar.show(state, animated: state.tab == shownTab)
    shownTab = state.chrome == .none ? nil : state.tab
    // The pop of a back swipe brings a new entry: the bar fades back in.
    if let swipeEntryId, swipeEntryId != state.entryId {
      endBackSwipe()
    }
    bar.setDimmed(state.modal)
    menus.pageDidShow(entryId: state.entryId)
    monthPicker.close(keeping: state.entryId)
    formatting.update(state.toolbar)
  }

  /// Sends a native tap to the page. The web view becomes first responder
  /// first: WebKit raises the keyboard for a focus only in the first
  /// responder, and a tap on a native button leaves the web view without it.
  private func send(_ intent: ChromeIntent) {
    _ = host.webView.becomeFirstResponder()
    host.chrome.send(intent)
  }

  private func presentMonthPicker(_ month: String, from source: UIView) {
    guard let entryId = host.chrome.state?.entryId else { return }
    monthPicker.present(month: month, entryId: entryId, from: source, in: container)
  }

  /// A user back swipe starts to move the page, or settles back without a
  /// pop. The bar fades out as the swipe starts, and back in as it settles
  /// back or as the next entry arrives.
  private func backSwipe(started: Bool) {
    guard started else {
      endBackSwipe()
      return
    }
    guard swipeEntryId == nil, let state = host.chrome.state else { return }
    swipeEntryId = state.entryId
    bar.setFaded(true, animated: true)
  }

  private func endBackSwipe() {
    swipeEntryId = nil
    bar.setFaded(false, animated: true)
  }

  /// The window changed size (rotation, iPhone Duo posture, iPad split).
  func sizeDidChange() {
    formatting.sizeDidChange()
  }

  /// A new document started: nothing of the old page stays on screen. The
  /// theme stays until the first state, so a pinned style does not flip.
  private func reset() {
    menus.closeAll()
    monthPicker.close()
    shownTab = nil
    swipeEntryId = nil
    bar.reset()
    formatting.update(nil)
    formatting.reset()
    tabs.reset()
  }

  /// Pins the light or dark style that the page pins, so the system bars match it.
  private func applyTheme(_ theme: ChromeTheme) {
    let style: UIUserInterfaceStyle =
      switch theme {
      case .system: .unspecified
      case .light: .light
      case .dark: .dark
      }
    container.view.window?.overrideUserInterfaceStyle = style
  }
}
