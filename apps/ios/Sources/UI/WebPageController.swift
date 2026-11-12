import ChromeKit
import UIKit
import WebKit

/// One page of the native chrome. It holds the web view while its tab is
/// selected, edge to edge, so the system bars float over the page and reach
/// the web layout through the safe area. Its navigation item is the native
/// navigation bar of the page.
@MainActor
final class WebPageController: UIViewController {
  /// The tab of this page, or `nil` for the page of a build without a tab bar.
  let chromeTab: ChromeTab?

  init(tab: ChromeTab?) {
    self.chromeTab = tab
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func loadView() {
    let view = UIView()
    view.backgroundColor = .systemBackground
    self.view = view
  }

  /// Whether the web view is in this page.
  func holds(_ webView: WKWebView) -> Bool {
    webView.superview === view
  }

  /// Moves the web view into this page, under every other subview.
  func attach(_ webView: WKWebView) {
    guard !holds(webView) else { return }
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.insertSubview(webView, at: 0)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }
}
