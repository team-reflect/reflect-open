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
  /// The tab the user tapped, until the page shows it. States posted before
  /// the tap still name the old tab, so they must not move the selection back.
  private var pendingTab: ChromeTab?
  /// The picture of the old tab over the new page until the page shows the new tab.
  private var cover: UIView?

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
    // The launch look: no bars before the first state.
    isTabBarHidden = true
    pages[.daily]?.attach(webView)
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
    return UITab(title: title, image: UIImage(systemName: icon), identifier: tab.rawValue) { _ in
      navigation
    }
  }

  /// Follows a state: selects its tab, holds the web view in its page, and
  /// hides the bar while the keyboard or a web drawer is up.
  func apply(_ state: ChromeState) {
    if pendingTab == state.tab {
      pendingTab = nil
    }
    if pendingTab == nil {
      follow(state.tab)
    }
    let hidden = state.chrome == .none || state.keyboardVisible || state.modal
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
    pendingTab = nil
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
      pendingTab = next
      move(to: page)
    }
    return true
  }

  /// Moves the web view into `page` behind a picture of the old tab, so the
  /// old tab's content never shows in the new tab for a frame. The picture
  /// fades out when the page shows the new tab, or after 0.5 s.
  private func move(to page: WebPageController) {
    cover?.removeFromSuperview()
    let picture = webView.snapshotView(afterScreenUpdates: false)
    page.loadViewIfNeeded()
    page.attach(webView)
    guard let picture else { return }
    picture.frame = page.view.bounds
    picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    page.view.addSubview(picture)
    cover = picture
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self, weak page] in
      guard let self, let page else { return }
      self.removeCover(from: page)
      if self.pendingTab == page.chromeTab {
        self.pendingTab = nil
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
