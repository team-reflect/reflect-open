import Foundation
import WebKit

/// Keeps the web view on the web app: a main-frame navigation to any other
/// page opens with the system handler. A `target=_blank` link does the same,
/// or loads in this web view when it stays in the web app.
@MainActor
final class ExternalNavigation: NSObject, WKNavigationDelegate, WKUIDelegate {
  private let startURL: URL
  private let openURL: @MainActor (URL) -> Void

  /// `startURL` is the page of the web app: the bundled one or a dev server.
  init(startURL: URL, openURL: @escaping @MainActor (URL) -> Void) {
    self.startURL = startURL
    self.openURL = openURL
  }

  /// Whether a main-frame navigation to `url` leaves the web app. The app's
  /// own schemes, the origin of `startURL`, and document-local schemes stay.
  static func isExternal(_ url: URL, startURL: URL) -> Bool {
    switch url.scheme?.lowercased() {
    case AppSchemeHandler.scheme, "reflect-asset", "about", "blob", "data", nil:
      return false
    default:
      return url.scheme != startURL.scheme || url.host != startURL.host
        || effectivePort(of: url) != effectivePort(of: startURL)
    }
  }

  /// The port of a URL, with the default of `http` and `https` for a URL
  /// that names none.
  private static func effectivePort(of url: URL) -> Int? {
    url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
  ) async -> WKNavigationActionPolicy {
    guard let url = navigationAction.request.url,
      navigationAction.targetFrame?.isMainFrame ?? true,
      Self.isExternal(url, startURL: startURL)
    else { return .allow }
    openURL(url)
    return .cancel
  }

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let url = navigationAction.request.url else { return nil }
    if Self.isExternal(url, startURL: startURL) {
      openURL(url)
    } else {
      webView.load(navigationAction.request)
    }
    return nil
  }
}
