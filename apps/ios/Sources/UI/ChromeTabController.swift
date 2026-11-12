import ChromeKit
import UIKit
import WebKit

/// The native tab bar: one navigation controller per tab, each with a
/// ``WebPageController`` root. The one web view moves into the page of the
/// selected tab. The page owns navigation: a tap sends a `tab` intent, and the
/// selection follows the tab of each state.
@MainActor
final class ChromeTabController: UITabBarController, UITabBarControllerDelegate {
  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }

  private let webView: WKWebView
  private var pages: [ChromeTab: WebPageController] = [:]
  /// Set while the selection follows a state, so it sends no intent.
  private var following = false
  /// The tab to select, with a tap that waits for the page (at most 2 s).
  private var tabFollow = TabFollow()
  /// The picture of the old tab over the new page until the page shows the new tab.
  private var cover: UIView?
  /// The last state's reasons to hide the tab bar.
  private var hidesForState = true
  private var hidesForKeyboard = false

  init(webView: WKWebView) {
    self.webView = webView
    super.init(nibName: nil, bundle: nil)
    tabs = [
      makeTab(.daily, title: "Daily", icon: "square.and.pencil"),
      makeTab(.all, title: "All", icon: "doc.on.doc"),
      makeTab(.tasks, title: "Tasks", icon: "checkmark.circle"),
    ]
    mode = .tabSidebar
    delegate = self
    view.tintColor = UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0x63 / 255, green: 0x66 / 255, blue: 0xF1 / 255, alpha: 1)
        : UIColor(red: 0x4F / 255, green: 0x46 / 255, blue: 0xE5 / 255, alpha: 1)
    }
    // The page scrolls inside its own elements, so the edge effect of the web
    // view's scroll view would only draw a band under the navigation bar.
    if #available(iOS 26, *) {
      webView.scrollView.topEdgeEffect.isHidden = true
    }
    // The launch look: no bars before the first state.
    isTabBarHidden = true
    pages[.daily]?.attach(webView)
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) {
      (self: Self, _: UITraitCollection) in
      self.updateTabBarHidden()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// The page that holds the web view.
  var currentPage: WebPageController? {
    pages.values.first { $0.holds(webView) }
  }

  /// The page of `tab`.
  func page(for tab: ChromeTab) -> WebPageController? {
    pages[tab]
  }

  private func makeTab(_ tab: ChromeTab, title: String, icon: String) -> UITab {
    let page = WebPageController(tab: tab)
    pages[tab] = page
    let navigation = UINavigationController(rootViewController: page)
    navigation.setNavigationBarHidden(true, animated: false)
    // The page scrolls inside the web view, never under the bar, so the bar
    // shows the page's own background.
    let appearance = UINavigationBarAppearance()
    appearance.configureWithTransparentBackground()
    navigation.navigationBar.standardAppearance = appearance
    navigation.navigationBar.scrollEdgeAppearance = appearance
    navigation.navigationBar.compactAppearance = appearance
    return UITab(title: title, image: UIImage(systemName: icon), identifier: tab.rawValue) { _ in
      navigation
    }
  }

  /// Follows a state: selects its tab, holds the web view in its page, and
  /// hides the bar while a web drawer is up, or while the keyboard is up and
  /// the bar sits at the bottom.
  func apply(_ state: ChromeState) {
    if let tab = tabFollow.state(state.tab) {
      follow(tab)
    }
    hidesForState = state.chrome == .none || state.modal
    hidesForKeyboard = state.keyboardVisible
    updateTabBarHidden()
  }

  /// In a regular width the bar sits at the top, where the keyboard never
  /// reaches it.
  private func updateTabBarHidden() {
    let atBottom = traitCollection.horizontalSizeClass != .regular
    let hidden = hidesForState || (hidesForKeyboard && atBottom)
    if hidden != isTabBarHidden {
      setTabBarHidden(hidden, animated: true)
    }
  }

  private func follow(_ chromeTab: ChromeTab) {
    if let tab = tabs.first(where: { $0.identifier == chromeTab.rawValue }), selectedTab !== tab {
      following = true
      selectedTab = tab
      following = false
    }
    if let page = pages[chromeTab] {
      page.attach(webView)
      removeCover(from: page)
    }
  }

  /// A new document: back to the launch look.
  func reset() {
    tabFollow = TabFollow()
    hidesForState = true
    hidesForKeyboard = false
    for page in pages.values {
      page.clearBar()
    }
    if let cover {
      cover.removeFromSuperview()
      self.cover = nil
    }
    setTabBarHidden(true, animated: false)
  }

  func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool
  {
    guard !following, let next = ChromeTab(rawValue: tab.identifier) else { return true }
    send(.tab(next))
    if tab !== selectedTab, let page = pages[next] {
      tabFollow.tap(next)
      move(to: page)
    }
    return true
  }

  /// Moves the web view into `page` behind a picture of the old tab, so the
  /// old tab's content never shows in the new tab for a frame. The picture
  /// fades out when the page shows the new tab, or after 2 s (a first visit
  /// can wait for a lazy screen). If the page never shows the new tab (it
  /// dropped the tap), the selection follows the tab of the last state.
  private func move(to page: WebPageController) {
    cover?.removeFromSuperview()
    let picture = webView.snapshotView(afterScreenUpdates: false)
    page.loadViewIfNeeded()
    // The page's bar shows its last visit until the first state of the tab.
    page.navigationController?.setNavigationBarHidden(true, animated: false)
    page.attach(webView)
    guard let picture else { return }
    picture.frame = page.view.bounds
    picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    page.view.addSubview(picture)
    cover = picture
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self, weak page] in
      guard let self, let page else { return }
      self.removeCover(from: page)
      // The page did not show the tapped tab: follow the tab it shows.
      if let pageTab = page.chromeTab, let tab = self.tabFollow.timeOut(pageTab) {
        self.follow(tab)
      }
    }
  }

  private func removeCover(from page: WebPageController) {
    guard let cover, cover.superview === page.view else { return }
    self.cover = nil
    UIView.animate(withDuration: 0.1) {
      cover.alpha = 0
    } completion: { _ in
      cover.removeFromSuperview()
    }
  }
}
