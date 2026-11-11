import XCTest

@testable import Reflect

@MainActor
final class DeepLinksTests: XCTestCase {
  private var events: [String] = []

  private func deepLinks() -> DeepLinks {
    DeepLinks { [weak self] name, payload in
      self?.events.append("\(name) \(String(decoding: payload, as: UTF8.self))")
    }
  }

  private func url(_ string: String) -> URL {
    URL(string: string) ?? URL(fileURLWithPath: "/")
  }

  func testLaunchURLsWaitForThePage() {
    let deepLinks = deepLinks()
    deepLinks.open([url("reflect://note/a")])
    deepLinks.open([url("reflect://note/b")])

    XCTAssertEqual(events, [])
    XCTAssertEqual(deepLinks.takePending(), ["reflect://note/a", "reflect://note/b"])
    XCTAssertNil(deepLinks.takePending())
  }

  func testOnlyTheNewestLaunchURLsWait() {
    let deepLinks = deepLinks()
    for i in 0..<(DeepLinks.pendingLimit + 2) {
      deepLinks.open([url("reflect://note/\(i)")])
    }
    let pending = deepLinks.takePending()
    XCTAssertEqual(pending?.count, DeepLinks.pendingLimit)
    XCTAssertEqual(pending?.first, "reflect://note/2")
  }

  func testLaterURLsAreEvents() {
    let deepLinks = deepLinks()
    XCTAssertNil(deepLinks.takePending())

    deepLinks.open([url("reflect://note/c")])
    deepLinks.open([])

    XCTAssertEqual(events, [#"host:open-url ["reflect:\/\/note\/c"]"#])
    XCTAssertNil(deepLinks.takePending())
  }
}
