import WebKit
import XCTest

@testable import WebHostKit

@MainActor
final class AssetSchemeHandlerTests: XCTestCase {
  private let webView = WKWebView()
  private var fileURL = URL(fileURLWithPath: "/")
  private var bytes = Data()

  override func setUp() async throws {
    fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("AssetSchemeHandlerTests-\(UUID().uuidString).bin")
    bytes = Data((0..<600_000).map { UInt8($0 % 251) })
    try bytes.write(to: fileURL)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: fileURL)
  }

  private func get(
    _ path: String = "/1%2Fassets%2Fa.bin", method: String = "GET", range: String? = nil,
    resolution: AssetResolution? = nil
  ) async -> FakeSchemeTask {
    let resolution = resolution ?? .file(path: fileURL.path, mime: "video/mp4", total: 600_000)
    let handler = AssetSchemeHandler { _, _, _ in resolution }
    var request = URLRequest(
      url: URL(string: "reflect-asset://localhost\(path)") ?? URL(fileURLWithPath: "/"))
    request.httpMethod = method
    request.setValue(range, forHTTPHeaderField: "Range")
    let fake = FakeSchemeTask(request)
    handler.webView(webView, start: fake)
    await fake.waitForEnd()
    return fake
  }

  func testServesTheWholeFile() async {
    let fake = await get()
    XCTAssertEqual(fake.response?.statusCode, 200)
    XCTAssertEqual(fake.header("Content-Type"), "video/mp4")
    XCTAssertEqual(fake.header("Content-Length"), "600000")
    XCTAssertEqual(fake.header("Accept-Ranges"), "bytes")
    XCTAssertEqual(fake.body, bytes)
  }

  func testServesTheRangeOfTheResolution() async {
    let fake = await get(
      resolution: .file(
        path: fileURL.path, mime: "video/mp4", total: 600_000, range: 300_000...599_998))
    XCTAssertEqual(fake.response?.statusCode, 206)
    XCTAssertEqual(fake.header("Content-Range"), "bytes 300000-599998/600000")
    XCTAssertEqual(fake.header("Content-Length"), "299999")
    XCTAssertEqual(fake.body, bytes.subdata(in: 300_000..<599_999))
  }

  func testAnswersAnUnsatisfiableRangeWithTheFileLength() async {
    let fake = await get(resolution: .refused(status: 416, total: 600_000))
    XCTAssertEqual(fake.response?.statusCode, 416)
    XCTAssertEqual(fake.header("Content-Range"), "bytes */600000")
    XCTAssertTrue(fake.body.isEmpty)
  }

  func testAnswersTheResolverStatus() async {
    let fake = await get(resolution: .refused(status: 403))
    XCTAssertEqual(fake.response?.statusCode, 403)
  }

  func testAFileOfAnotherLengthIs500() async {
    let fake = await get(resolution: .file(path: fileURL.path, mime: "video/mp4", total: 5))
    XCTAssertEqual(fake.response?.statusCode, 500)
  }

  func testAMissingFileIs404() async {
    let fake = await get(resolution: .file(path: "/no/such/file", mime: "image/png", total: 1))
    XCTAssertEqual(fake.response?.statusCode, 404)
  }

  func testOnlyGETIsAllowed() async {
    let fake = await get(method: "POST")
    XCTAssertEqual(fake.response?.statusCode, 405)
  }

  func testResolverGetsTheDecodedPathTheQueryAndTheRange() async {
    let seen = Seen()
    let handler = AssetSchemeHandler { path, query, range in
      await seen.record("\(path) \(query ?? "-") \(range ?? "-")")
      return .refused(status: 404)
    }
    var request = URLRequest(
      url: URL(string: "reflect-asset://localhost/7%2Fassets%2Fmy%20cat.png?reflect-preview=raster")
        ?? URL(fileURLWithPath: "/"))
    request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
    let fake = FakeSchemeTask(request)
    handler.webView(webView, start: fake)
    await fake.waitForEnd()
    let calls = await seen.calls
    XCTAssertEqual(calls, ["7/assets/my cat.png reflect-preview=raster bytes=0-1"])
  }
}

private actor Seen {
  var calls: [String] = []

  func record(_ call: String) {
    calls.append(call)
  }
}
