import Foundation
import XCTest

@testable import ChromeKit

final class NativeChromeTests: XCTestCase {
  private func defaults(_ values: [String: Bool]) -> UserDefaults {
    let name = "NativeChromeTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    for (key, value) in values {
      defaults.set(value, forKey: key)
    }
    return defaults
  }

  func testReadsTheInfoPlistValue() {
    XCTAssertTrue(NativeChrome.isEnabled(listed: "YES", defaults: nil, allowOverride: false))
    XCTAssertFalse(NativeChrome.isEnabled(listed: "NO", defaults: nil, allowOverride: false))
    XCTAssertFalse(NativeChrome.isEnabled(listed: "", defaults: nil, allowOverride: false))
    XCTAssertFalse(NativeChrome.isEnabled(listed: nil, defaults: nil, allowOverride: false))
  }

  func testTheOverrideAppliesOnlyWhenAllowed() {
    let off = defaults([NativeChrome.overrideKey: false])
    XCTAssertFalse(NativeChrome.isEnabled(listed: "YES", defaults: off, allowOverride: true))
    XCTAssertTrue(NativeChrome.isEnabled(listed: "YES", defaults: off, allowOverride: false))
    let on = defaults([NativeChrome.overrideKey: true])
    XCTAssertTrue(NativeChrome.isEnabled(listed: "NO", defaults: on, allowOverride: true))
  }
}
