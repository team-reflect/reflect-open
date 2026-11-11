import KeyboardKit
import SwiftRs
import Tauri
import UIKit
import WebKit

/// Applies the keyboard tuning of `KeyboardKit` to the Tauri webview (Plan
/// 19, decision 8). Tauri has no iOS keyboard handling (tauri#9907).
class KeyboardPlugin: Plugin {
  private var keyboardTuning: NSKeyValueObservation?

  @objc public override func load(webview: WKWebView) {
    // Tauri loads its plugins on the main thread.
    keyboardTuning = MainActor.assumeIsolated { KeyboardTuning.apply(to: webview) }
  }
}

@_cdecl("init_plugin_keyboard")
public func initPlugin() -> Plugin {
  return KeyboardPlugin()
}
