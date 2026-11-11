import WebKit
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

  func testEventsWaitForTheFirstDocumentAndKeepTheirOrder() {
    let bridge = bridge()
    bridge.emit("index:changed", payload: Data(#"{"n":1}"#.utf8))
    bridge.emit("note:moved", payload: Data())
    XCTAssertEqual(scripts, [])

    bridge.documentDidStart()
    XCTAssertEqual(
      scripts,
      [
        #"window.__reflectHost.dispatch("index:changed", {"n":1})"#,
        #"window.__reflectHost.dispatch("note:moved", null)"#,
      ])

    bridge.emit("a\"b", payload: Data("[]".utf8))
    XCTAssertEqual(scripts.last, #"window.__reflectHost.dispatch("a\"b", [])"#)
  }

  func testTheQueueDropsTheOldestEvents() {
    let bridge = bridge()
    for i in 0..<(HostBridge.queueLimit + 2) {
      bridge.emit("e", payload: Data(String(i).utf8))
    }
    bridge.documentDidStart()
    XCTAssertEqual(scripts.count, HostBridge.queueLimit)
    XCTAssertEqual(scripts.first, #"window.__reflectHost.dispatch("e", 2)"#)
  }

  /// Runs the injected script in a real web view: an event that arrives
  /// before its listener reaches that listener, in order.
  func testAnEventWaitsInThePageForItsFirstListener() async throws {
    let bridge = HostBridge()
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.addUserScript(HostBridge.userScript)
    configuration.userContentController.add(bridge, name: HostBridge.messageHandlerName)
    let webView = WKWebView(frame: .zero, configuration: configuration)
    bridge.evaluate = { [weak webView] script in webView?.evaluateJavaScript(script) }

    // Before the document exists: waits in the shell.
    bridge.emit("index:changed", payload: Data(#"{"n":1}"#.utf8))
    webView.loadHTMLString("<html></html>", baseURL: URL(string: "https://bridge.invalid/"))
    try await poll("the document starts") { bridge.hasDocument }

    // After the document, before any listener: waits in the page.
    bridge.emit("index:changed", payload: Data(#"{"n":2}"#.utf8))
    bridge.emit("other", payload: Data("0".utf8))
    // An unrelated subscription does not take the events of another name.
    _ = try await webView.callAsyncJavaScript(
      "window.__other = []; window.__reflectHost.on('other', (p) => window.__other.push(p))",
      contentWorld: .page)

    _ = try await webView.callAsyncJavaScript(
      "window.__seen = []; window.__reflectHost.on('index:changed', (p) => window.__seen.push(p.n))",
      contentWorld: .page)
    bridge.emit("index:changed", payload: Data(#"{"n":3}"#.utf8))

    var seen: [Int] = []
    try await poll("three events arrive") {
      seen = (try? await webView.evaluateJavaScript("window.__seen") as? [Int]) ?? []
      return seen.count == 3
    }
    XCTAssertEqual(seen, [1, 2, 3])
    let other = try await webView.evaluateJavaScript("window.__other") as? [Int]
    XCTAssertEqual(other, [0])
  }

  func testThePageQueueDropsTheOldestEventsOfAName() async throws {
    let bridge = HostBridge()
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.addUserScript(HostBridge.userScript)
    configuration.userContentController.add(bridge, name: HostBridge.messageHandlerName)
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.loadHTMLString("<html></html>", baseURL: URL(string: "https://bridge.invalid/"))
    try await poll("the document starts") { bridge.hasDocument }

    let count = HostBridge.pendingLimit + 2
    let first = try await webView.callAsyncJavaScript(
      """
      for (let i = 0; i < \(count); i++) window.__reflectHost.dispatch('e', i)
      const seen = []
      window.__reflectHost.on('e', (p) => seen.push(p))
      await new Promise((resolve) => setTimeout(resolve, 0))
      return [seen.length, seen[0]]
      """, contentWorld: .page)
    XCTAssertEqual(first as? [Int], [HostBridge.pendingLimit, 2])
  }

  private func poll(_ what: String, until condition: () async -> Bool) async throws {
    // The first web view of a new simulator takes long to start its processes.
    let deadline = Date().addingTimeInterval(60)
    while !(await condition()) {
      guard Date() < deadline else {
        XCTFail("timed out before \(what)")
        return
      }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
  }
}
