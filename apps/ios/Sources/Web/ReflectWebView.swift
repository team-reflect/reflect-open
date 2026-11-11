import ObjectiveC
import UIKit
import WebKit

/// The web view that renders the web app from the `reflect-app` scheme.
///
/// The web app sizes itself from `visualViewport` when the keyboard opens, so
/// the web view stays pinned: no automatic insets, a scroll offset of zero, no
/// form assistant bar, and a keyboard for every `focus()`.
@MainActor
final class ReflectWebView: WKWebView {
  private var contentOffsetObservation: NSKeyValueObservation?

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

    // WebKit scrolls the native scroll view to reveal the caret when the
    // keyboard opens. The page is always viewport-sized, so this resets any
    // offset to zero.
    contentOffsetObservation = scrollView.observe(\.contentOffset, options: [.new]) {
      scrollView, _ in
      MainActor.assumeIsolated {
        guard scrollView.contentOffset != .zero else { return }
        scrollView.setContentOffset(.zero, animated: false)
      }
    }
    _ = Self.allowProgrammaticFocus
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// No form assistant bar above the keyboard. WebKit returns the web view's
  /// `inputAccessoryView` from its content view.
  override var inputAccessoryView: UIView? {
    nil
  }

  /// Makes a `focus()` outside a user gesture open the keyboard.
  ///
  /// WebKit opens the keyboard only when its content view's private focus
  /// method gets `userIsInteracting` as true. This replaces that method once
  /// with one that always passes true. When the class or the method is
  /// missing, it changes nothing and the keyboard opens on user taps only.
  private static let allowProgrammaticFocus: Void = {
    guard let contentClass = NSClassFromString(["WK", "Content", "View"].joined()) else { return }
    let selector = NSSelectorFromString(
      [
        "_element", "Did", "Focus:", "user", "Is", "Interacting:", "blur", "Previous", "Node:",
        "activity", "State", "Changes:", "user", "Object:",
      ].joined())
    guard let method = class_getInstanceMethod(contentClass, selector) else { return }
    typealias ElementDidFocus =
      @convention(c) (AnyObject, Selector, UnsafeRawPointer, Bool, Bool, UInt, AnyObject?) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: ElementDidFocus.self)
    let replacement:
      @convention(block) (AnyObject, UnsafeRawPointer, Bool, Bool, UInt, AnyObject?) -> Void = {
        view, element, _, blurPreviousNode, activityStateChanges, userObject in
        original(view, selector, element, true, blurPreviousNode, activityStateChanges, userObject)
      }
    method_setImplementation(method, imp_implementationWithBlock(replacement))
  }()
}
