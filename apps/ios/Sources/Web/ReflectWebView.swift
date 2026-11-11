import UIKit
import WebKit

/// The web view that renders the web app from the `reflect-app` scheme.
@MainActor
final class ReflectWebView: WKWebView {
  init(
    routes: [any SchemeRoute], assets: AssetSchemeHandler, bridge: HostBridge
  ) {
    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(
      AppSchemeHandler(routes: routes), forURLScheme: AppSchemeHandler.scheme)
    configuration.setURLSchemeHandler(assets, forURLScheme: AssetSchemeHandler.scheme)
    configuration.userContentController.addUserScript(HostBridge.userScript)
    configuration.userContentController.add(bridge, name: HostBridge.messageHandlerName)
    configuration.allowsInlineMediaPlayback = true
    configuration.allowsPictureInPictureMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.preferences.isElementFullscreenEnabled = true
    configuration.websiteDataStore = .default()
    super.init(frame: .zero, configuration: configuration)

    bridge.evaluate = { [weak self] script in
      self?.evaluateJavaScript(script)
    }
    isOpaque = false
    backgroundColor = .systemBackground
    scrollView.bounces = false
    scrollView.contentInsetAdjustmentBehavior = .never
    #if DEBUG
    if #available(iOS 16.4, *) {
      isInspectable = true
    }
    #endif
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }
}
