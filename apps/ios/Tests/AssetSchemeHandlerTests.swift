import WebKit
import XCTest

@testable import Reflect

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
    let resolution = resolution ?? .file(path: fileURL.path, mime: "video/mp4")
    let handler = AssetSchemeHandler { _, _ in resolution }
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

  func testServesARange() async {
    let fake = await get(range: "bytes=300000-599998")
    XCTAssertEqual(fake.response?.statusCode, 206)
    XCTAssertEqual(fake.header("Content-Range"), "bytes 300000-599998/600000")
    XCTAssertEqual(fake.header("Content-Length"), "299999")
    XCTAssertEqual(fake.body, bytes.subdata(in: 300_000..<599_999))
  }

  func testRefusesAnUnsatisfiableRange() async {
    let fake = await get(range: "bytes=600000-")
    XCTAssertEqual(fake.response?.statusCode, 416)
    XCTAssertEqual(fake.header("Content-Range"), "bytes */600000")
    XCTAssertTrue(fake.body.isEmpty)
  }

  func testAnswersTheResolverStatus() async {
    let fake = await get(resolution: .refused(status: 403))
    XCTAssertEqual(fake.response?.statusCode, 403)
  }

  func testAFileOfAnotherLengthIs500() async {
    let fake = await get(resolution: .file(path: fileURL.path, mime: "video/mp4", length: 5))
    XCTAssertEqual(fake.response?.statusCode, 500)
    let same = await get(resolution: .file(path: fileURL.path, mime: "video/mp4", length: 600_000))
    XCTAssertEqual(same.response?.statusCode, 200)
  }

  func testAMissingFileIs404() async {
    let fake = await get(resolution: .file(path: "/no/such/file", mime: "image/png"))
    XCTAssertEqual(fake.response?.statusCode, 404)
  }

  func testOnlyGETIsAllowed() async {
    let fake = await get(method: "POST")
    XCTAssertEqual(fake.response?.statusCode, 405)
  }

  func testResolverGetsTheDecodedPathAndTheRasterFlag() async {
    let seen = Seen()
    let handler = AssetSchemeHandler { path, rasterOnly in
      await seen.record(path, rasterOnly)
      return .refused(status: 404)
    }
    for url in [
      "reflect-asset://localhost/7%2Fassets%2Fmy%20cat.png?reflect-preview=raster",
      "reflect-asset://localhost/7%2Fx-media%2F123%2Fabc",
    ] {
      let fake = FakeSchemeTask(URLRequest(url: URL(string: url) ?? URL(fileURLWithPath: "/")))
      handler.webView(webView, start: fake)
      await fake.waitForEnd()
    }
    let calls = await seen.calls
    XCTAssertEqual(calls, ["7/assets/my cat.png raster", "7/x-media/123/abc any"])
  }

  func testByteRange() {
    typealias Handler = AssetSchemeHandler
    XCTAssertEqual(Handler.byteRange(header: nil, length: 10), .whole)
    XCTAssertEqual(Handler.byteRange(header: "bytes=2-4", length: 10), .partial(2...4))
    XCTAssertEqual(Handler.byteRange(header: "bytes=-3", length: 10), .partial(7...9))
    XCTAssertEqual(Handler.byteRange(header: "bytes=7-", length: 10), .partial(7...9))
    XCTAssertEqual(Handler.byteRange(header: "bytes=2-99", length: 10), .partial(2...9))
    XCTAssertEqual(Handler.byteRange(header: "bytes=-99", length: 10), .partial(0...9))
    XCTAssertEqual(Handler.byteRange(header: "bytes=10-", length: 10), .unsatisfiable)
    XCTAssertEqual(Handler.byteRange(header: "bytes=4-2", length: 10), .unsatisfiable)
    XCTAssertEqual(Handler.byteRange(header: "bytes=0-", length: 0), .unsatisfiable)
    XCTAssertEqual(Handler.byteRange(header: "bytes=0-1,3-4", length: 10), .whole)
    XCTAssertEqual(Handler.byteRange(header: "items=0-1", length: 10), .whole)
  }
}

private actor Seen {
  var calls: [String] = []

  func record(_ path: String, _ rasterOnly: Bool) {
    calls.append("\(path) \(rasterOnly ? "raster" : "any")")
  }
}
