import WebKit
import XCTest

@testable import WebHostKit

@MainActor
final class AppSchemeHandlerTests: XCTestCase {
  private final class RecordingRoute: SchemeRoute {
    let pathPrefix: String
    var started: [SchemeTask] = []

    init(pathPrefix: String) {
      self.pathPrefix = pathPrefix
    }

    func start(_ task: SchemeTask) {
      started.append(task)
    }
  }

  private let webView = WKWebView()

  func testRequestGoesToTheFirstMatchingRoute() {
    let ipc = RecordingRoute(pathPrefix: "/__ipc/")
    let http = RecordingRoute(pathPrefix: "/__http")
    let shadowed = RecordingRoute(pathPrefix: "/__ipc/")
    let handler = AppSchemeHandler(routes: [ipc, http, shadowed])

    handler.webView(webView, start: FakeSchemeTask(path: "/__http?url=x"))
    handler.webView(webView, start: FakeSchemeTask(path: "/__ipc/settings_load"))

    XCTAssertEqual(ipc.started.count, 1)
    XCTAssertEqual(http.started.count, 1)
    XCTAssertEqual(shadowed.started.count, 0)
  }

  func testStopReachesTheRouteTask() {
    let route = RecordingRoute(pathPrefix: "/__ipc/")
    let handler = AppSchemeHandler(routes: [route])
    let fake = FakeSchemeTask(path: "/__ipc/settings_load")
    handler.webView(webView, start: fake)

    handler.webView(webView, stop: fake)
    route.started[0].reply(SchemeReply(statusCode: 200, headers: [:], body: Data()))

    XCTAssertFalse(route.started[0].isLive)
    XCTAssertTrue(fake.isUntouched)
  }

  func testOtherPathsAreStaticFiles() async {
    let handler = AppSchemeHandler(routes: [RecordingRoute(pathPrefix: "/__ipc/")])
    let fake = FakeSchemeTask(path: "/no-such-file.txt")
    handler.webView(webView, start: fake)
    await fake.waitForEnd()
    XCTAssertEqual(fake.response?.statusCode, 404)
  }
}
