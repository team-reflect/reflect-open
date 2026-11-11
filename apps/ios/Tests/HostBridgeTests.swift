import XCTest

@testable import Reflect

@MainActor
final class HostBridgeTests: XCTestCase {
  private var scripts: [String] = []

  private func bridge() -> HostBridge {
    let bridge = HostBridge()
    bridge.evaluate = { [weak self] in self?.scripts.append($0) }
    return bridge
  }

  func testEventsWaitUntilReadyAndKeepTheirOrder() {
    let bridge = bridge()
    bridge.emit("index:changed", payload: Data(#"{"n":1}"#.utf8))
    bridge.emit("note:moved", payload: Data())
    XCTAssertEqual(scripts, [])

    bridge.markReady()
    XCTAssertEqual(
      scripts,
      [
        #"window.__reflectHost.dispatch("index:changed", {"n":1})"#,
        #"window.__reflectHost.dispatch("note:moved", null)"#,
      ])

    bridge.emit("a\"b", payload: Data("[]".utf8))
    XCTAssertEqual(scripts.last, #"window.__reflectHost.dispatch("a\"b", [])"#)
  }

  func testANewDocumentQueuesEventsAgain() {
    let bridge = bridge()
    bridge.markReady()
    bridge.reset()
    bridge.emit("index:changed", payload: Data("1".utf8))
    XCTAssertEqual(scripts, [])
    bridge.markReady()
    XCTAssertEqual(scripts.count, 1)
  }

  func testTheQueueDropsTheOldestEvents() {
    let bridge = bridge()
    for i in 0..<(HostBridge.queueLimit + 2) {
      bridge.emit("e", payload: Data(String(i).utf8))
    }
    bridge.markReady()
    XCTAssertEqual(scripts.count, HostBridge.queueLimit)
    XCTAssertEqual(scripts.first, #"window.__reflectHost.dispatch("e", 2)"#)
  }
}
