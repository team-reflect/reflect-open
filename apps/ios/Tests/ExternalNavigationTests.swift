import XCTest

@testable import Reflect

@MainActor
final class ExternalNavigationTests: XCTestCase {
  private func isExternal(_ url: String, start: String = AppSchemeHandler.indexURL) -> Bool {
    guard let url = URL(string: url), let start = URL(string: start) else { return true }
    return ExternalNavigation.isExternal(url, startURL: start)
  }

  func testTheWebAppStaysInTheWebView() {
    XCTAssertFalse(isExternal("reflect-app://localhost/index.html"))
    XCTAssertFalse(isExternal("reflect-app://localhost/__host/selfcheck"))
    XCTAssertFalse(isExternal("about:blank"))
    XCTAssertFalse(isExternal("blob:reflect-app://localhost/1"))
    XCTAssertFalse(isExternal("http://localhost:1420/src/x", start: "http://localhost:1420"))
  }

  func testOtherPagesOpenWithTheSystem() {
    XCTAssertTrue(isExternal("https://reflect.app/"))
    XCTAssertTrue(isExternal("http://localhost:1420/"))
    XCTAssertTrue(isExternal("mailto:a@example.com"))
    XCTAssertTrue(isExternal("http://localhost:3000/", start: "http://localhost:1420"))
    XCTAssertTrue(isExternal("https://localhost:1420/", start: "http://localhost:1420"))
  }
}
