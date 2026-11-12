import ChromeKit
import KeyboardKit
import UIKit
import WebHostKit
import WebKit

/// The web view that renders the web app from the `reflect-app` scheme.
///
/// The web app sizes itself from `visualViewport` when the keyboard opens, so
/// the web view has the keyboard tuning of `KeyboardKit`.
@MainActor
final class ReflectWebView: WKWebView {
  private var keyboardTuning: NSKeyValueObservation?

  init(
    routes: [any SchemeRoute], assets: AssetSchemeHandler, bridge: HostBridge,
    chrome: ChromeBridge, chromeFeatures: Set<ChromeFeature>
  ) {
    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(
      AppSchemeHandler(routes: routes), forURLScheme: AppSchemeHandler.scheme)
    configuration.setURLSchemeHandler(assets, forURLScheme: AssetSchemeHandler.scheme)
    configuration.userContentController.addUserScript(HostBridge.userScript)
    configuration.userContentController.add(bridge, name: HostBridge.messageHandlerName)
    if !chromeFeatures.isEmpty {
      configuration.userContentController.addUserScript(ChromeFeatures.userScript(chromeFeatures))
      configuration.userContentController.addUserScript(ChromeBridge.userScript)
      configuration.userContentController.add(chrome, name: ChromeBridge.messageHandlerName)
    }
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
    #if DEBUG
    isInspectable = true
    #endif

    keyboardTuning = KeyboardTuning.apply(to: self)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }
}
