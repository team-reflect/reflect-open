import Tauri
import UIKit

/// The app's haptics surface, split out of `KeyboardPlugin` so the keyboard
/// plugin stays pure webview tuning. WKWebView has no `navigator.vibrate`,
/// so JS cannot fire haptics on its own; taps cross the bridge to
/// `UIImpactFeedbackGenerator` here.
class MobileHapticsPlugin: Plugin {
  // Lazy so the generator is created on the main thread, inside the first
  // `impactLight` dispatch; kept alive across taps to skip re-allocating
  // the underlying haptic engine on every press.
  private lazy var lightImpactGenerator = UIImpactFeedbackGenerator(style: .light)

  /// Fire a light impact haptic — V1 parity for date-selection, task controls,
  /// and tab taps. `UIFeedbackGenerator` is main-thread-only; resolve immediately
  /// rather than after the dispatch since the tap has already happened and
  /// callers are fire-and-forget. Silently does nothing on hardware
  /// without a haptic engine (iPads, the simulator).
  @objc public func impactLight(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.lightImpactGenerator.impactOccurred()
    }
    invoke.resolve()
  }
}

@_cdecl("init_plugin_mobile_haptics")
func initPlugin() -> Plugin {
  return MobileHapticsPlugin()
}
