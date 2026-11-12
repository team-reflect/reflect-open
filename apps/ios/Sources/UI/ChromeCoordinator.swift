import ChromeKit
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
  private let features: Set<ChromeFeature>
  /// The container of the pages: the root's only child.
  let container: UIViewController
  /// The native tab bar, when the build draws it.
  private let tabs: ChromeTabController?
  /// The only page, when the build draws no tab bar.
  private let page: WebPageController?
  private let menus = MenuPresenter()
  private let formatting: FormattingAccessory?
  /// Set during a web slide: a bar shown on both pages keeps the old page
  /// until the slide ends.
  private var barFrozen = false
  /// Bumped on every slide start, so an old timeout never thaws a newer slide.
  private var slide = 0

  init(host: AppHost) {
    self.host = host
    features = host.chromeFeatures
    if features.contains(.tabbar) {
      let tabs = ChromeTabController(webView: host.webView)
      self.tabs = tabs
      page = nil
      container = tabs
    } else {
      let page = WebPageController(tab: nil)
      page.loadViewIfNeeded()
      page.attach(host.webView)
      self.page = page
      tabs = nil
      container = page
    }
    formatting = features.contains(.toolbar) ? FormattingAccessory(webView: host.webView) : nil

    let bridge = host.chrome
    menus.send = { [weak self] intent in self?.send(intent) }
    tabs?.send = { [weak self] intent in self?.send(intent) }
    menus.presenter = { [weak self] in self?.container }
    formatting?.send = { [weak self] intent in self?.send(intent) }
    formatting?.presenter = { [weak self] in self?.container }
    bridge.onState = { [weak self] state in self?.apply(state) }
    bridge.onReset = { [weak self] in self?.reset() }
    bridge.onPresentMenu = { [weak self] request in self?.presentMenu(request) }
    bridge.onTransition = { [weak self] started in self?.transition(started: started) }
    bridge.onError = { message in Self.logger.error("\(message, privacy: .public)") }
  }

  private func apply(_ state: ChromeState) {
    #if DEBUG
    Self.logger.debug(
      "state \(state.generation) entry \(state.entryId) \(state.routeKind ?? "none", privacy: .public)"
    )
    #endif
    applyTheme(state.theme)
    tabs?.apply(state)
    // A bar that comes or goes changes the page's top safe area, so it
    // changes as the slide starts, not as the new page lands.
    if !barFrozen || tabs?.page(for: state.tab)?.barVisibilityChanges(for: state) == true {
      showBar(state)
    }
    if features.contains(.navbar) {
      tabs?.page(for: state.tab)?.setBarDimmed(state.modal)
    }
    menus.pageDidShow(entryId: state.entryId)
    formatting?.update(state.toolbar)
  }

  /// Sends a native tap to the page. The web view becomes first responder
  /// first: WebKit raises the keyboard for a focus only in the first
  /// responder, and a tap on a native bar leaves the web view without it.
  private func send(_ intent: ChromeIntent) {
    _ = host.webView.becomeFirstResponder()
    host.chrome.send(intent)
  }

  /// Shows the navigation bar of `state` in the page of its tab.
  private func showBar(_ state: ChromeState) {
    guard features.contains(.navbar), let page = tabs?.page(for: state.tab) else { return }
    page.showBar(state, menus: menus) { [weak self] intent in self?.send(intent) }
  }

  /// A web push or pop slide starts or ends. During the slide a bar shown
  /// on both pages keeps the old page; at the end it cross-fades to the
  /// latest state. A lost end
  /// thaws the bar after one second.
  private func transition(started: Bool) {
    // An end without a slide (a tab switch, the first mount) changes nothing.
    guard features.contains(.navbar), started || barFrozen else { return }
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
    guard let state = host.chrome.state,
      let bar = tabs?.page(for: state.tab)?.navigationController?.navigationBar
    else { return }
    UIView.transition(with: bar, duration: 0.2, options: .transitionCrossDissolve) {
      self.showBar(state)
    }
  }

  /// The page asks for a menu at one of its elements, for the entry on screen.
  private func presentMenu(_ request: MenuRequest) {
    guard features.contains(.menus), host.chrome.state?.entryId == request.entryId else { return }
    guard let view = (tabs?.currentPage ?? page)?.view else { return }
    menus.present(request, webView: host.webView, in: view)
  }

  /// The window changed size (rotation, iPhone Duo posture, iPad split).
  func sizeDidChange() {
    formatting?.sizeDidChange()
  }

  /// A new document started: nothing of the old page stays on screen. The
  /// theme stays until the first state, so a pinned style does not flip.
  private func reset() {
    menus.closeAll()
    barFrozen = false
    formatting?.update(nil)
    formatting?.reset()
    tabs?.reset()
  }

  /// Pins the light or dark style that the page pins, so the system bars match it.
  private func applyTheme(_ theme: ChromeState.Theme) {
    let style: UIUserInterfaceStyle =
      switch theme {
      case .system: .unspecified
      case .light: .light
      case .dark: .dark
      }
    container.view.window?.overrideUserInterfaceStyle = style
  }
}
