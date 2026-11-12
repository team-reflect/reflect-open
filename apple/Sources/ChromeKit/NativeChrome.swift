public import Foundation
public import WebKit

/// Whether this build draws the mobile chrome (navigation bar, tab bar, and
/// keyboard toolbar) natively.
public enum NativeChrome {
  /// The Info.plist key: `YES` when the build draws the native chrome.
  public static let infoKey = "ReflectNativeChrome"
  /// The user defaults key that overrides the Info.plist value when allowed.
  public static let overrideKey = "nativeChrome"

  /// Whether `value` (an Info.plist string such as `YES`) turns the native
  /// chrome on, with the `nativeChrome` override of `defaults` applied when
  /// `allowOverride`.
  public static func isEnabled(
    listed value: String?, defaults: UserDefaults?, allowOverride: Bool
  ) -> Bool {
    if allowOverride, let defaults, defaults.object(forKey: overrideKey) != nil {
      return defaults.bool(forKey: overrideKey)
    }
    return (value as NSString?)?.boolValue ?? false
  }

  /// Whether `bundle`'s Info.plist turns the native chrome on, with the
  /// override of `defaults`.
  public static func isEnabled(
    bundle: Bundle, defaults: UserDefaults, allowOverride: Bool
  ) -> Bool {
    isEnabled(
      listed: bundle.object(forInfoDictionaryKey: infoKey) as? String, defaults: defaults,
      allowOverride: allowOverride)
  }

  /// The user script that sets `window.__nativeChrome` before any page
  /// script runs.
  public static let userScript = WKUserScript(
    source: "window.__nativeChrome = true;", injectionTime: .atDocumentStart,
    forMainFrameOnly: true)
}
