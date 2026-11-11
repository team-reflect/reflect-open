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

  func testEventsWaitForThePageAndKeepTheirOrder() {
    let bridge = bridge()
    bridge.emit("index:changed", payload: Data(#"{"n":1}"#.utf8))
    bridge.emit("note:moved", payload: Data())
    XCTAssertEqual(scripts, [])

    bridge.pageDidBecomeReady()
    XCTAssertEqual(
      scripts,
      [
        #"window.__reflectHost.dispatch("index:changed", {"n":1})"#,
        #"window.__reflectHost.dispatch("note:moved", null)"#,
      ])

    bridge.emit("a\"b", payload: Data("[]".utf8))
    XCTAssertEqual(scripts.last, #"window.__reflectHost.dispatch("a\"b", [])"#)
  }

  func testEventsWaitAgainWhenANewDocumentStarts() {
    let bridge = bridge()
    bridge.pageDidBecomeReady()
    bridge.documentDidStart()
    bridge.emit("e", payload: Data("1".utf8))
    XCTAssertEqual(scripts, [])

    bridge.pageDidBecomeReady()
    XCTAssertEqual(scripts, [#"window.__reflectHost.dispatch("e", 1)"#])
  }

  func testTheQueueDropsTheOldestEvents() {
    let bridge = bridge()
    for i in 0..<(HostBridge.queueLimit + 2) {
      bridge.emit("e", payload: Data(String(i).utf8))
    }
    bridge.pageDidBecomeReady()
    XCTAssertEqual(scripts.count, HostBridge.queueLimit)
    XCTAssertEqual(scripts.first, #"window.__reflectHost.dispatch("e", 2)"#)
  }

  /// Runs the bridge in a real web view: the events that the shell emits
  /// before the page posts `ready` reach the page after it, in order.
  func testAPageGetsTheEventsThatWaitedForIt() async throws {
    let bridge = HostBridge()
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.addUserScript(HostBridge.userScript)
    configuration.userContentController.add(bridge, name: HostBridge.messageHandlerName)
    let webView = WKWebView(frame: .zero, configuration: configuration)
    bridge.evaluate = { [weak webView] script in webView?.evaluateJavaScript(script) }

    bridge.emit("a", payload: Data("1".utf8))
    let page = """
      <script>
        window.seen = []
        window.__reflectHost = { dispatch: (name, payload) => window.seen.push([name, payload]) }
        window.webkit.messageHandlers.reflectHost.postMessage('ready')
      </script>
      """
    webView.loadHTMLString(page, baseURL: URL(string: "https://bridge.invalid/"))
    for _ in 0..<600 where !bridge.isPageReady {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    bridge.emit("b", payload: Data("2".utf8))

    let seen = try await webView.evaluateJavaScript("JSON.stringify(window.seen)") as? String
    XCTAssertEqual(seen, #"[["a",1],["b",2]]"#)
  }
}
