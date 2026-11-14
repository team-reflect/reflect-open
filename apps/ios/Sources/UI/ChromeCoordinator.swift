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
  private let formatting: FormattingAccessory
  /// Set during a web slide: the corner buttons keep the old page until the
  /// slide ends.
  private var barFrozen = false
  /// Bumped on every slide start, so an old timeout never thaws a newer slide.
  private var slide = 0
  /// The tab of the last state, so corner buttons cross-fade only within one
  /// page.
  private var shownTab: ChromeTab?
  /// The page whose corner buttons a back swipe faded out, and the entry it
  /// showed.
  private var swipe: (page: WebPageController, entryId: Int)?

  init(host: AppHost) {
    self.host = host
    tabs = ChromeTabController(webView: host.webView)
    formatting = FormattingAccessory(webView: host.webView)

    let bridge = host.chrome
    menus.send = { [weak self] intent in self?.send(intent) }
    tabs.send = { [weak self] intent in self?.send(intent) }
    tabs.onCornersInHeaderRow = { [bridge] inHeaderRow in bridge.cornersInHeaderRow = inHeaderRow }
    tabs.onSidebarVisible = { [bridge] visible in bridge.sidebarVisible = visible }
    menus.presenter = { [weak self] in self?.container }
    formatting.send = { [weak self] intent in self?.send(intent) }
    formatting.presenter = { [weak self] in self?.container }
    bridge.onState = { [weak self] state in self?.apply(state) }
    bridge.onReset = { [weak self] in self?.reset() }
    bridge.onTransition = { [weak self] started in self?.transition(started: started) }
    bridge.onBackSwipe = { [weak self] started in self?.backSwipe(started: started) }
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
    if !barFrozen {
      // During a back swipe the buttons are faded out: they change at once
      // and fade back in.
      showBar(state, animated: state.tab == shownTab && swipe == nil)
    }
    shownTab = state.tab
    // The pop of a back swipe brings a new entry: its buttons fade back in.
    if let swipe, swipe.entryId != state.entryId {
      endBackSwipe(animated: true)
    }
    tabs.page(for: state.tab)?.setBarDimmed(state.modal)
    menus.pageDidShow(entryId: state.entryId)
    formatting.update(state.toolbar)
  }

  /// Sends a native tap to the page. The web view becomes first responder
  /// first: WebKit raises the keyboard for a focus only in the first
  /// responder, and a tap on a native button leaves the web view without it.
  private func send(_ intent: ChromeIntent) {
    _ = host.webView.becomeFirstResponder()
    host.chrome.send(intent)
  }

  /// Shows the corner buttons of `state` in the page of its tab.
  private func showBar(_ state: ChromeState, animated: Bool) {
    guard let page = tabs.page(for: state.tab) else { return }
    page.showBar(state, animated: animated, menus: menus) { [weak self] intent in
      self?.send(intent)
    }
  }

  /// A user back swipe starts to move the page, or settles back without a
  /// pop. The corner buttons of the page fade out as the swipe starts, and
  /// back in as it settles back or as the next entry arrives.
  private func backSwipe(started: Bool) {
    guard started else {
      endBackSwipe(animated: true)
      return
    }
    guard swipe == nil, let state = host.chrome.state, let page = tabs.page(for: state.tab)
    else { return }
    swipe = (page, state.entryId)
    page.setBarFaded(true, animated: true)
  }

  private func endBackSwipe(animated: Bool) {
    swipe?.page.setBarFaded(false, animated: animated)
    swipe = nil
  }

  /// A web push or pop slide starts or ends. During the slide the corner
  /// buttons keep the old page; at the end they animate to the latest
  /// state. A lost end thaws them after one second.
  private func transition(started: Bool) {
    // An end without a slide (a tab switch, the first mount) changes nothing.
    guard started || barFrozen else { return }
    slide += 1
    let current = slide
    barFrozen = started
    if started {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
        guard let self, self.slide == current else { return }
        self.transition(started: false)
      }
      return
    }
    guard let state = host.chrome.state else { return }
    showBar(state, animated: true)
  }

  /// The window changed size (rotation, iPhone Duo posture, iPad split).
  func sizeDidChange() {
    formatting.sizeDidChange()
  }

  /// A new document started: nothing of the old page stays on screen. The
  /// theme stays until the first state, so a pinned style does not flip.
  private func reset() {
    menus.closeAll()
    barFrozen = false
    shownTab = nil
    endBackSwipe(animated: false)
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
