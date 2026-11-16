import UIKit
import WebKit

/// The root of the stage. It holds the web view edge to edge, so the bars
/// float over the page and reach the web layout through the safe area.
@MainActor
final class WebPageController: UIViewController {
  override func loadView() {
    let view = UIView()
    view.backgroundColor = .systemBackground
    self.view = view
  }

  /// Moves the web view into this page, under every other subview. A web
  /// view that had the focus gets it back, as leaving the window resigns it.
  func attach(_ webView: WKWebView) {
    guard webView.superview !== view else { return }
    let focused = Self.holdsFirstResponder(webView)
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.insertSubview(webView, at: 0)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    if focused {
      _ = webView.becomeFirstResponder()
    }
  }

  private static func holdsFirstResponder(_ view: UIView) -> Bool {
    view.isFirstResponder || view.subviews.contains { holdsFirstResponder($0) }
  }
}
