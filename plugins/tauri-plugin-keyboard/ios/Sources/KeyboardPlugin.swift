import ObjectiveC
import SwiftRs
import Tauri
import UIKit
import WebKit

/// The payload for both the `keyboardChange` event and `currentHeight`.
struct KeyboardState: Encodable {
  /// Points of webview height the keyboard currently covers (0 = hidden).
  let height: Float
  /// The keyboard's animation duration in seconds, for matching CSS motion.
  let duration: Float
}

/// Reflect's keyboard bridge (Plan 19, decision 8).
///
/// Tauri has no iOS keyboard handling (tauri#9907): by default the system
/// nudges the webview's scroll view around when the keyboard animates in,
/// occluding whatever the caret is in. This plugin takes manual control —
/// the webview keeps its full-screen frame, scroll-view auto-adjustment is
/// disabled, and the keyboard's overlap height streams to JS as
/// `keyboardChange` events so the layout can make room (a CSS variable, a
/// pinned toolbar, caret scroll-into-view).
///
/// As Reflect's only native UIKit touch bridge, it also carries the app's
/// tiny haptics surface (`impactLight`) — WKWebView has no
/// `navigator.vibrate`, so JS cannot fire haptics on its own.
class KeyboardPlugin: Plugin {
  private weak var webView: WKWebView?
  private var currentState = KeyboardState(height: 0, duration: 0)
  // Lazy so the generator is created on the main thread, inside the first
  // `impactLight` dispatch; kept alive across taps to skip re-allocating
  // the underlying haptic engine on every press.
  private lazy var lightImpactGenerator = UIImpactFeedbackGenerator(style: .light)

  @objc public override func load(webview: WKWebView) {
    self.webView = webview
    // The system's automatic inset adjustment is the source of the jump:
    // page layout owns keyboard avoidance instead (via the events below).
    webview.scrollView.contentInsetAdjustmentBehavior = .never
    // iOS injects a form-assistant bar (‹ › field stepper + Done) above the
    // keyboard for any focused field or contenteditable. Reflect edits one
    // continuous document, so the bar is meaningless chrome — strip it.
    Self.suppressInputAccessoryBar()
    let center = NotificationCenter.default
    center.addObserver(
      self,
      selector: #selector(keyboardWillChangeFrame(_:)),
      name: UIResponder.keyboardWillChangeFrameNotification,
      object: nil
    )
    center.addObserver(
      self,
      selector: #selector(keyboardWillHide(_:)),
      name: UIResponder.keyboardWillHideNotification,
      object: nil
    )
  }

  /// The keyboard's frame in the webview's coordinate space decides the
  /// overlap; a hardware-keyboard bar or an undocked keyboard yields the
  /// honest (smaller or zero) height rather than a guessed constant.
  @objc private func keyboardWillChangeFrame(_ notification: Notification) {
    guard
      let webView = self.webView,
      let endFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
    else {
      return
    }
    let frameInWebView = webView.convert(endFrame, from: nil)
    let overlap = max(0, webView.bounds.maxY - frameInWebView.minY)
    emit(height: Float(overlap), notification: notification)
  }

  @objc private func keyboardWillHide(_ notification: Notification) {
    emit(height: 0, notification: notification)
  }

  private func emit(height: Float, notification: Notification) {
    let duration =
      (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0
    let state = KeyboardState(height: height, duration: Float(duration))
    currentState = state
    do {
      try trigger("keyboardChange", data: state)
    } catch {
      Logger.error("keyboard event failed to serialize: \(error)")
    }
  }

  /// Mount-time state for late subscribers (the keyboard may already be up
  /// when a screen mounts and subscribes).
  @objc public func currentHeight(_ invoke: Invoke) {
    invoke.resolve(currentState)
  }

  /// Fire a light impact haptic — V1 parity for date-selection and tab
  /// taps. `UIFeedbackGenerator` is main-thread-only; resolve immediately
  /// rather than after the dispatch since the tap has already happened and
  /// callers are fire-and-forget. Silently does nothing on hardware
  /// without a haptic engine (iPads, the simulator).
  @objc public func impactLight(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.lightImpactGenerator.impactOccurred()
    }
    invoke.resolve()
  }

  /// `WKContentView` (the webview's private first responder) returns the
  /// keyboard's form-assistant bar from `inputAccessoryView`. Replace that
  /// getter at the *class* level with one returning nil, so the swap doesn't
  /// depend on the content view already existing when the plugin loads, and so
  /// it survives the content view being recreated. Guarded by the class lookup,
  /// so a future WebKit rename degrades to "bar stays" rather than crashing.
  /// Idempotent via the static flag. iPad's separate `inputAssistantItem`
  /// shortcut bar is intentionally left untouched here.
  private static var didSuppressAccessoryBar = false
  private static func suppressInputAccessoryBar() {
    guard !didSuppressAccessoryBar, let contentClass = NSClassFromString("WKContentView")
    else { return }
    didSuppressAccessoryBar = true
    let selector = NSSelectorFromString("inputAccessoryView")
    let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    let implementation = imp_implementationWithBlock(block)
    if let method = class_getInstanceMethod(contentClass, selector) {
      class_replaceMethod(contentClass, selector, implementation, method_getTypeEncoding(method))
    } else {
      class_replaceMethod(contentClass, selector, implementation, "@@:")
    }
  }
}

@_cdecl("init_plugin_keyboard")
func initPlugin() -> Plugin {
  return KeyboardPlugin()
}
