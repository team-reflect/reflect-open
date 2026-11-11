import Foundation
import WebKit

/// The file that an asset request names, or the HTTP status to refuse it with.
enum AssetResolution: Sendable, Equatable {
  case file(path: String, mime: String)
  case refused(status: Int)
}

/// Handles the `reflect-asset` scheme: the files of the open graph's `assets/`
/// folder. The URL is `reflect-asset://localhost/<generation>/<path>` with the
/// part after the host percent-encoded as one segment.
/// `?reflect-preview=raster` asks for raster images only.
///
/// The resolver decides which file a request names. The handler reads the
/// file in chunks off the main thread and answers a single-range `Range`
/// request with 206.
@MainActor
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
  typealias Resolve =
    @Sendable (_ requestPath: String, _ rasterOnly: Bool) async -> AssetResolution

  static let scheme = "reflect-asset"
  static let chunkSize = 256 * 1024

  private let resolve: Resolve
  /// The tasks that WebKit started and that did not end yet.
  private var tasks: [ObjectIdentifier: SchemeTask] = [:]

  init(resolve: @escaping Resolve) {
    self.resolve = resolve
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    let id = ObjectIdentifier(urlSchemeTask)
    let task = SchemeTask(urlSchemeTask)
    tasks[id] = task
    task.onEnd { [weak self] in
      self?.tasks[id] = nil
    }

    guard task.request.httpMethod == "GET" else {
      Self.refuse(task, status: 405)
      return
    }
    guard let url = task.request.url,
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let requestPath = components.percentEncodedPath.dropFirst().removingPercentEncoding
    else {
      Self.refuse(task, status: 400)
      return
    }
    let rasterOnly = (components.percentEncodedQuery ?? "").split(separator: "&")
      .contains("reflect-preview=raster")
    let range = task.request.value(forHTTPHeaderField: "Range")

    Task {
      switch await resolve(requestPath, rasterOnly) {
      case .refused(let status):
        Self.refuse(task, status: status)
      case .file(let path, let mime):
        await Self.serve(path: path, mime: mime, rangeHeader: range, to: task)
      }
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    tasks[ObjectIdentifier(urlSchemeTask)]?.stop()
  }

  /// The bytes that a `Range` header selects from a file of `length` bytes.
  enum ByteRange: Equatable {
    /// No header, or one this handler ignores: the whole file.
    case whole
    case partial(ClosedRange<UInt64>)
    case unsatisfiable
  }

  /// Parses `bytes=<first>-<last>`, `bytes=<first>-` and `bytes=-<suffix>`. A
  /// header with several ranges or another unit selects the whole file.
  static func byteRange(header: String?, length: UInt64) -> ByteRange {
    guard let header, header.hasPrefix("bytes="), !header.contains(",") else { return .whole }
    let parts = header.dropFirst("bytes=".count).split(
      separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else { return .whole }
    let first = parts[0].trimmingCharacters(in: .whitespaces)
    let last = parts[1].trimmingCharacters(in: .whitespaces)

    if first.isEmpty {
      guard let suffix = UInt64(last) else { return .whole }
      guard suffix > 0, length > 0 else { return .unsatisfiable }
      return .partial((length - min(suffix, length))...(length - 1))
    }
    guard let start = UInt64(first) else { return .whole }
    guard start < length else { return .unsatisfiable }
    if last.isEmpty {
      return .partial(start...(length - 1))
    }
    guard let end = UInt64(last) else { return .whole }
    guard end >= start else { return .unsatisfiable }
    return .partial(start...min(end, length - 1))
  }

  private static func refuse(_ task: SchemeTask, status: Int) {
    task.reply(SchemeReply(statusCode: status, headers: [:], body: Data()))
  }

  private static func serve(
    path: String, mime: String, rangeHeader: String?, to task: SchemeTask
  ) async {
    guard let file = await AssetFile.open(path: path) else {
      refuse(task, status: 404)
      return
    }
    var headers = ["Content-Type": mime, "Accept-Ranges": "bytes"]
    let selected: ClosedRange<UInt64>?
    switch byteRange(header: rangeHeader, length: file.length) {
    case .unsatisfiable:
      task.reply(
        SchemeReply(
          statusCode: 416, headers: ["Content-Range": "bytes */\(file.length)"], body: Data()))
      return
    case .whole:
      selected = file.length > 0 ? 0...(file.length - 1) : nil
      headers["Content-Length"] = String(file.length)
      task.respond(status: 200, headers: headers)
    case .partial(let range):
      selected = range
      headers["Content-Length"] = String(range.count)
      headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound)/\(file.length)"
      task.respond(status: 206, headers: headers)
    }

    if let selected {
      var offset = selected.lowerBound
      while offset <= selected.upperBound, task.isLive {
        let count = Int(min(UInt64(chunkSize), selected.upperBound - offset + 1))
        guard let chunk = await file.read(offset: offset, count: count), !chunk.isEmpty else {
          task.fail(URLError(.cannotLoadFromNetwork))
          return
        }
        task.send(chunk)
        offset += UInt64(chunk.count)
      }
    }
    task.finish()
  }
}

/// An open asset file. Its reads run off the main thread: a read of an iCloud
/// file can wait for a download.
private final class AssetFile: @unchecked Sendable {
  let length: UInt64
  private let handle: FileHandle

  private init(handle: FileHandle, length: UInt64) {
    self.handle = handle
    self.length = length
  }

  deinit {
    try? handle.close()
  }

  @concurrent
  static func open(path: String) async -> AssetFile? {
    guard let handle = FileHandle(forReadingAtPath: path),
      let length = try? handle.seekToEnd()
    else { return nil }
    return AssetFile(handle: handle, length: length)
  }

  /// Reads up to `count` bytes at `offset`. One task reads at a time.
  @concurrent
  func read(offset: UInt64, count: Int) async -> Data? {
    do {
      try handle.seek(toOffset: offset)
      return try handle.read(upToCount: count)
    } catch {
      return nil
    }
  }
}
