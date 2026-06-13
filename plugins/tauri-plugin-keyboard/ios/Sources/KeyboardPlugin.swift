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
class KeyboardPlugin: Plugin {
  private weak var webView: WKWebView?
  private var currentState = KeyboardState(height: 0, duration: 0)

  @objc public override func load(webview: WKWebView) {
    self.webView = webview
    // The system's automatic inset adjustment is the source of the jump:
    // page layout owns keyboard avoidance instead (via the events below).
    webview.scrollView.contentInsetAdjustmentBehavior = .never
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
}

@_cdecl("init_plugin_keyboard")
func initPlugin() -> Plugin {
  return KeyboardPlugin()
}
