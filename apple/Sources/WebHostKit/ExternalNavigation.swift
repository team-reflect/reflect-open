public import Foundation
public import WebKit

/// Keeps the web view on the web app: a main-frame navigation to any other
/// page opens with the system handler. A `target=_blank` link does the same,
/// or loads in this web view when it stays in the web app. When the system
/// ends the web content process, the page loads again.
@MainActor
public final class ExternalNavigation: NSObject, WKNavigationDelegate, WKUIDelegate {
  private let startURL: URL
  private let openURL: @MainActor (URL) -> Void
  private let warn: @MainActor (String) -> Void
  private var terminations = 0

  /// `startURL` is the page of the web app: the bundled one or a dev server.
  /// `warn` gets a log line each time the web content process ends.
  public init(
    startURL: URL, openURL: @escaping @MainActor (URL) -> Void,
    warn: @escaping @MainActor (String) -> Void
  ) {
    self.startURL = startURL
    self.openURL = openURL
    self.warn = warn
  }

  /// Whether a main-frame navigation to `url` leaves the web app. The app's
  /// own schemes, the origin of `startURL`, and document-local schemes stay.
  public static func isExternal(_ url: URL, startURL: URL) -> Bool {
    switch url.scheme?.lowercased() {
    case AppSchemeHandler.scheme, "reflect-asset", "about", "blob", "data", nil:
      return false
    default:
      return url.scheme != startURL.scheme || url.host != startURL.host
        || url.effectivePort != startURL.effectivePort
    }
  }

  public func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
  ) async -> WKNavigationActionPolicy {
    guard let url = navigationAction.request.url,
      navigationAction.targetFrame?.isMainFrame ?? true,
      Self.isExternal(url, startURL: startURL)
    else { return .allow }
    openURL(url)
    return .cancel
  }

  public func webView(
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

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    terminations += 1
    warn("the web content process ended (\(terminations) in this launch)")
    webView.reload()
  }
}
