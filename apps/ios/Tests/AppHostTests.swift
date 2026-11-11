import XCTest

@testable import Reflect

@MainActor
final class AppHostTests: XCTestCase {
  private func origin(_ url: String) -> String? {
    URL(string: url).flatMap(AppHost.origin(of:))
  }

  func testOriginOmitsTheDefaultPort() {
    XCTAssertEqual(origin("http://localhost:1420/x"), "http://localhost:1420")
    XCTAssertEqual(origin("http://localhost:80/"), "http://localhost")
    XCTAssertEqual(origin("https://dev.example:443"), "https://dev.example")
    XCTAssertEqual(origin("http://[::1]:1420/"), "http://[::1]:1420")
  }
}
