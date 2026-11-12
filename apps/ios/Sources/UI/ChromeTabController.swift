import ChromeKit
import UIKit
import WebKit

/// The native tab bar. Each tab holds an empty placeholder; one stage (a
/// navigation controller with a hidden bar, whose root page holds the web
/// view) sits over the
/// selected placeholder, under the tab bar and the sidebar. A tab tap only
/// moves the selection and sends a `tab` intent: the web view never moves,
/// and the page draws the new tab in place. The selection follows the tab of
/// each state.
@MainActor
final class ChromeTabController: UITabBarController, UITabBarControllerDelegate {
  /// The narrowest window that shows the sidebar. A narrower window shows
  /// only the tab bar.
  private static let sidebarMinWidth: CGFloat = 1100

  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }

  private let webView: WKWebView
  /// The one page: it holds the web view for every tab.
  private let page = WebPageController(tab: .daily)
  /// The navigation controller of the page. It stays in place for every tab.
  private let stage: UINavigationController
  private var placeholders: [ChromeTab: TabPlaceholder] = [:]
  private var stagePins: [NSLayoutConstraint] = []
  private weak var pinnedTo: UIView?
  /// Set while the selection follows a state, so it sends no intent.
  private var following = false
  /// The tab to select, with a tap that waits for the page (at most 2 s).
  private var tabFollow = TabFollow()
  /// Counts taps, so the timeout of an earlier tap does nothing.
  private var taps = 0
  /// The last state's reasons to hide the tab bar.
  private var hidesForState = true
  private var hidesForKeyboard = false
  /// Whether the page shows its shell, so a tap on a tab moves to it. The
  /// iPad sidebar stays tappable while the tab bar is hidden.
  private var showsShell = false

  init(webView: WKWebView) {
    self.webView = webView
    stage = UINavigationController(rootViewController: page)
    super.init(nibName: nil, bundle: nil)
    // The page draws its own top row, under the native corner buttons.
    stage.setNavigationBarHidden(true, animated: false)
    tabs = [
      makeTab(.daily, title: "Daily", image: UIImage(systemName: "square.and.pencil")),
      makeTab(.all, title: "All", image: UIImage(systemName: "doc.on.doc")),
      makeTab(.tasks, title: "Tasks", image: Self.outlineSymbol("checkmark.circle")),
    ]
    // A shown sidebar pins the content beside it.
    sidebar.preferredLayout = .tile
    delegate = self
    view.tintColor = UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0x63 / 255, green: 0x66 / 255, blue: 0xF1 / 255, alpha: 1)
        : UIColor(red: 0x4F / 255, green: 0x46 / 255, blue: 0xE5 / 255, alpha: 1)
    }
    // The page scrolls inside its own elements, so the edge effect of the web
    // view's scroll view would only draw a band at the top.
    if #available(iOS 26, *) {
      webView.scrollView.topEdgeEffect.isHidden = true
    }
    // The launch look: no bars before the first state.
    isTabBarHidden = true
    page.attach(webView)
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) {
      (self: Self, _: UITraitCollection) in
      self.updateTabBarHidden()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    addChild(stage)
    stage.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stage.view)
    stage.didMove(toParent: self)
  }

  override func viewWillTransition(
    to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator
  ) {
    super.viewWillTransition(to: size, with: coordinator)
    updateMode(width: size.width)
  }

  override func viewWillLayoutSubviews() {
    updateMode(width: view.bounds.width)
    super.viewWillLayoutSubviews()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    placeStage()
  }

  /// Shows the sidebar and its toggle in a window of at least
  /// `sidebarMinWidth`, and only the tab bar in a narrower window.
  private func updateMode(width: CGFloat) {
    let next: UITabBarController.Mode = width >= Self.sidebarMinWidth ? .tabSidebar : .tabBar
    if mode != next {
      mode = next
    }
  }

  /// The page of `tab`: the one page holds every tab.
  func page(for tab: ChromeTab) -> WebPageController? {
    page
  }

  private var selectedPlaceholder: TabPlaceholder? {
    selectedTab?.viewController as? TabPlaceholder
  }

  /// Puts the stage right above the view that holds the selected
  /// placeholder (so under the tab bar and the sidebar), over the
  /// placeholder's frame, with the placeholder's safe area.
  private func placeStage() {
    guard let placeholder = selectedPlaceholder, placeholder.isViewLoaded,
      placeholder.view.window != nil
    else { return }
    var holder: UIView = placeholder.view
    while let parent = holder.superview, parent !== view {
      holder = parent
    }
    guard holder.superview === view else { return }
    if let stageIndex = view.subviews.firstIndex(of: stage.view),
      let holderIndex = view.subviews.firstIndex(of: holder), stageIndex != holderIndex + 1
    {
      view.insertSubview(stage.view, aboveSubview: holder)
    }
    if pinnedTo !== placeholder.view || !stagePins.allSatisfy(\.isActive) {
      NSLayoutConstraint.deactivate(stagePins)
      stagePins = [
        stage.view.leadingAnchor.constraint(equalTo: placeholder.view.leadingAnchor),
        stage.view.trailingAnchor.constraint(equalTo: placeholder.view.trailingAnchor),
        stage.view.topAnchor.constraint(equalTo: placeholder.view.topAnchor),
        stage.view.bottomAnchor.constraint(equalTo: placeholder.view.bottomAnchor),
      ]
      NSLayoutConstraint.activate(stagePins)
      pinnedTo = placeholder.view
    }
    syncSafeArea(with: placeholder)
  }

  /// Gives the stage the safe area of the placeholder: the tab bar and the
  /// sidebar inset the placeholder, but not a sibling view of it.
  private func syncSafeArea(with placeholder: TabPlaceholder) {
    guard placeholder === selectedPlaceholder, let parent = stage.view.superview else { return }
    // The insets the stage gets from its parent alone.
    let safe = parent.bounds.inset(by: parent.safeAreaInsets)
    let frame = stage.view.frame
    let natural = UIEdgeInsets(
      top: max(0, safe.minY - frame.minY), left: max(0, safe.minX - frame.minX),
      bottom: max(0, frame.maxY - safe.maxY), right: max(0, frame.maxX - safe.maxX))
    let want = placeholder.view.safeAreaInsets
    // On iPad the floating tab bar sits at the top, right under the status
    // bar. The corner buttons share its row, as the bar buttons of a
    // navigation controller in the selected tab do.
    let windowTop = view.window?.safeAreaInsets.top ?? want.top
    let rowCenter: CGFloat? =
      want.top > windowTop + 1
      ? windowTop + WebPageController.buttonSize / 2 - frame.minY : nil
    if page.topRowCenter != rowCenter {
      page.topRowCenter = rowCenter
    }
    let extra = UIEdgeInsets(
      top: max(0, want.top - natural.top), left: max(0, want.left - natural.left),
      bottom: max(0, want.bottom - natural.bottom), right: max(0, want.right - natural.right))
    if extra != stage.additionalSafeAreaInsets {
      stage.additionalSafeAreaInsets = extra
      // The page keeps its old top inset after a sidebar toggle unless it
      // lays out again on the next run loop.
      DispatchQueue.main.async { [weak self] in
        self?.page.view.setNeedsLayout()
        self?.page.view.layoutIfNeeded()
      }
    }
  }

  /// A template image of a symbol at the tab bar's 23 pt symbol size. The tab
  /// bar shows a symbol's `.fill` variant, but shows a bitmap as it is.
  private static func outlineSymbol(_ name: String) -> UIImage? {
    let configuration = UIImage.SymbolConfiguration(pointSize: 23)
    guard
      let symbol = UIImage(systemName: name, variableValue: 1, configuration: configuration)
    else { return nil }
    let bitmap = UIGraphicsImageRenderer(size: symbol.size).image { _ in
      symbol.draw(at: .zero)
    }
    return bitmap.withRenderingMode(.alwaysTemplate)
  }

  private func makeTab(_ tab: ChromeTab, title: String, image: UIImage?) -> UITab {
    let placeholder = TabPlaceholder()
    placeholder.onLayout = { [weak self, weak placeholder] in
      guard let self, let placeholder, placeholder === self.selectedPlaceholder else { return }
      self.placeStage()
    }
    placeholders[tab] = placeholder
    return UITab(title: title, image: image, identifier: tab.rawValue) { _ in
      placeholder
    }
  }

  /// Follows a state: selects its tab, holds the web view in its page, and
  /// hides the bar while a web drawer is up, or while the keyboard is up and
  /// the bar sits at the bottom.
  func apply(_ state: ChromeState) {
    if let tab = tabFollow.state(state.tab) {
      follow(tab)
    }
    showsShell = state.chrome != .none
    hidesForState = !showsShell || state.modal
    hidesForKeyboard = state.keyboardVisible
    updateTabBarHidden()
  }

  /// On an iPad in a regular width the bar sits at the top, where the
  /// keyboard never reaches it.
  private func updateTabBarHidden() {
    let atBottom =
      traitCollection.userInterfaceIdiom != .pad || traitCollection.horizontalSizeClass != .regular
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
      placeStage()
    }
  }

  /// A new document: back to the launch look.
  func reset() {
    tabFollow = TabFollow()
    hidesForState = true
    hidesForKeyboard = false
    showsShell = false
    page.clearBar()
    setTabBarHidden(true, animated: false)
  }

  func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool
  {
    guard !following, let next = ChromeTab(rawValue: tab.identifier) else { return true }
    guard showsShell else { return false }
    send(.tab(next))
    if tab !== selectedTab {
      tabFollow.tap(next)
      taps += 1
      let tap = taps
      // The page did not show the tapped tab in 2 s: follow the tab it shows.
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        guard let self, self.taps == tap, let tab = self.tabFollow.timeOut(next) else { return }
        self.follow(tab)
      }
    }
    return true
  }

  func tabBarController(
    _ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?
  ) {
    placeStage()
  }
}

/// The empty content of one tab. Its frame and safe area tell where the
/// stage goes.
@MainActor
final class TabPlaceholder: UIViewController {
  /// Called when the frame or the safe area changes.
  var onLayout: () -> Void = {}

  override func loadView() {
    let view = UIView()
    view.backgroundColor = .clear
    self.view = view
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    onLayout()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    onLayout()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    onLayout()
  }
}
