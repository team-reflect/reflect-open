public import Foundation
public import WebKit

/// A part of the mobile chrome that the shell can draw natively.
public enum ChromeFeature: String, CaseIterable, Sendable {
  case menus
  case toolbar
  case tabbar
  case navbar

  /// The parts this part needs: the navigation bar sits in each tab's page.
  public var needs: [ChromeFeature] {
    switch self {
    case .navbar: [.tabbar]
    case .menus, .toolbar, .tabbar: []
    }
  }
}

/// Which parts this build draws.
public enum ChromeFeatures {
  /// The Info.plist key with the parts of the build, separated by spaces.
  public static let infoKey = "ReflectChromeFeatures"

  /// The parts listed in `value` (separated by spaces or commas), with each
  /// `chrome.<part>` override of `defaults` applied when `allowOverrides`.
  /// A part is on only when every part it needs is on.
  public static func enabled(
    listed value: String?, defaults: UserDefaults?, allowOverrides: Bool
  ) -> Set<ChromeFeature> {
    let names = (value ?? "").split(whereSeparator: { $0 == " " || $0 == "," })
    var features = Set(names.compactMap { ChromeFeature(rawValue: String($0)) })
    if allowOverrides, let defaults {
      for feature in ChromeFeature.allCases
      where defaults.object(forKey: "chrome.\(feature.rawValue)") != nil {
        if defaults.bool(forKey: "chrome.\(feature.rawValue)") {
          features.insert(feature)
        } else {
          features.remove(feature)
        }
      }
    }
    return features.filter { feature in feature.needs.allSatisfy(features.contains) }
  }

  /// The parts of `bundle`'s Info.plist, with the overrides of `defaults`.
  public static func enabled(
    bundle: Bundle, defaults: UserDefaults, allowOverrides: Bool
  ) -> Set<ChromeFeature> {
    enabled(
      listed: bundle.object(forInfoDictionaryKey: infoKey) as? String, defaults: defaults,
      allowOverrides: allowOverrides)
  }

  /// The user script that gives the page `window.__nativeChromeFeatures`
  /// before any page script runs.
  public static func userScript(_ features: Set<ChromeFeature>) -> WKUserScript {
    let names = features.map(\.rawValue).sorted()
    let json = (try? JSONEncoder().encode(names)).map { String(decoding: $0, as: UTF8.self) }
    return WKUserScript(
      source: "window.__nativeChromeFeatures = \(json ?? "[]");",
      injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }
}
