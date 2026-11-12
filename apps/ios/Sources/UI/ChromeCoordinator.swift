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
    bridge.onError = { message in Self.logger.error("\(message, privacy: .public)") }
  }

  private func apply(_ state: ChromeState) {
    #if DEBUG
    Self.logger.debug(
      "state \(state.generation) entry \(state.entryId) \(state.route?.kind ?? "none", privacy: .public)"
    )
    #endif
    applyTheme(state.theme)
    tabs?.apply(state)
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

  /// The page asks for a menu at one of its elements, for the entry on screen.
  private func presentMenu(_ request: MenuRequest) {
    guard features.contains(.menus), host.chrome.state?.entryId == request.entryId else { return }
    guard let view = (tabs?.currentPage ?? page)?.view else { return }
    menus.present(request, webView: host.webView, in: view)
  }

  /// A new document started: nothing of the old page stays on screen.
  private func reset() {
    menus.closeAll()
    formatting?.update(nil)
    tabs?.reset()
    applyTheme(.system)
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
