#if DEBUG
import Foundation

/// The data that a UI test gives a new session (`AppDirectories`): the JSON
/// file at the path in the environment variable `REFLECT_UITEST_FIXTURE`.
/// The store screenshots use it to start from a graph with notes, an AI
/// provider and a known answer from that provider. Debug builds only.
struct UITestFixture: Decodable, Sendable {
  /// Files by path, relative to the home of the session. A new session
  /// writes them before the app reads its settings or its graph.
  var files: [String: File]
  /// Keychain entries by name, stored through the Rust core.
  var secrets: [String: String]
  /// Response bodies by request URL, sent as an event stream by
  /// `HTTPProxy` without a request to the network.
  var responses: [String: String]

  struct File: Decodable, Sendable {
    var contents: String
    /// The modification time, in seconds since 1970. The app shows it as the
    /// time a note changed.
    var modified: Date?
  }

  static let current: UITestFixture? = {
    guard let path = ProcessInfo.processInfo.environment["REFLECT_UITEST_FIXTURE"] else {
      return nil
    }
    do {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .secondsSince1970
      return try decoder.decode(
        UITestFixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    } catch {
      // A fixture that the app cannot read makes every screenshot wrong.
      fatalError("REFLECT_UITEST_FIXTURE \(path): \(error)")
    }
  }()

  /// Writes `files` into `home`.
  func write(into home: URL, fileManager: FileManager) throws {
    for (path, file) in files {
      let url = home.appendingPathComponent(path)
      try fileManager.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(file.contents.utf8).write(to: url)
      if let modified = file.modified {
        try fileManager.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
      }
    }
  }
}

/// Answers the requests of `UITestFixture.responses`.
final class UITestURLProtocol: URLProtocol {
  private static let responses = UITestFixture.current?.responses ?? [:]

  override class func canInit(with request: URLRequest) -> Bool {
    request.url.map { responses[$0.absoluteString] != nil } ?? false
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    guard let url = request.url, let body = Self.responses[url.absoluteString],
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "text/event-stream"])
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
#endif
