import XCTest

@testable import WebHostKit

final class URLOriginTests: XCTestCase {
  private func origin(_ url: String) -> String? {
    URL(string: url)?.webOrigin
  }

  func testOriginOmitsTheDefaultPort() {
    XCTAssertEqual(origin("http://localhost:1420/x"), "http://localhost:1420")
    XCTAssertEqual(origin("http://localhost:80/"), "http://localhost")
    XCTAssertEqual(origin("https://dev.example:443"), "https://dev.example")
    XCTAssertEqual(origin("http://[::1]:1420/"), "http://[::1]:1420")
  }
}
