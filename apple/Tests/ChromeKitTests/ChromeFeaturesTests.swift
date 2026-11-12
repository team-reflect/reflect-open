import Foundation
import XCTest

@testable import ChromeKit

final class ChromeFeaturesTests: XCTestCase {
  private func defaults(_ values: [String: Bool]) -> UserDefaults {
    let name = "ChromeFeaturesTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    for (key, value) in values {
      defaults.set(value, forKey: key)
    }
    return defaults
  }

  func testReadsTheListedParts() {
    let features = ChromeFeatures.enabled(
      listed: "menus toolbar,unknown", defaults: nil, allowOverrides: false)
    XCTAssertEqual(features, [.menus, .toolbar])
  }

  func testNavbarNeedsTabbar() {
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "navbar", defaults: nil, allowOverrides: false), [])
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "navbar tabbar", defaults: nil, allowOverrides: false),
      [.navbar, .tabbar])
  }

  func testOverridesApplyOnlyWhenAllowed() {
    let overrides = defaults(["chrome.menus": false, "chrome.tabbar": true])
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "menus", defaults: overrides, allowOverrides: true),
      [.tabbar])
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "menus", defaults: overrides, allowOverrides: false),
      [.menus])
  }

  func testEmptyListDrawsNothing() {
    XCTAssertEqual(ChromeFeatures.enabled(listed: nil, defaults: nil, allowOverrides: true), [])
    XCTAssertEqual(ChromeFeatures.enabled(listed: "", defaults: nil, allowOverrides: false), [])
  }
}
