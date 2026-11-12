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
      listed: "toolbar tabbar,unknown", defaults: nil, allowOverrides: false)
    XCTAssertEqual(features, [.toolbar, .tabbar])
  }

  func testNavbarNeedsTabbar() {
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "navbar", defaults: nil, allowOverrides: false), [])
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "navbar tabbar", defaults: nil, allowOverrides: false),
      [.navbar, .tabbar])
  }

  func testOverridesApplyOnlyWhenAllowed() {
    let overrides = defaults(["chrome.toolbar": false, "chrome.tabbar": true])
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "toolbar", defaults: overrides, allowOverrides: true),
      [.tabbar])
    XCTAssertEqual(
      ChromeFeatures.enabled(listed: "toolbar", defaults: overrides, allowOverrides: false),
      [.toolbar])
  }

  func testEmptyListDrawsNothing() {
    XCTAssertEqual(ChromeFeatures.enabled(listed: nil, defaults: nil, allowOverrides: true), [])
    XCTAssertEqual(ChromeFeatures.enabled(listed: "", defaults: nil, allowOverrides: false), [])
  }
}
