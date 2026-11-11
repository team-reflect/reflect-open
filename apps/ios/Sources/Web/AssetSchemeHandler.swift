import Foundation
import WebKit

/// The file that an asset request names, or the HTTP status to refuse it with.
enum AssetResolution: Sendable, Equatable {
  /// `total` is the length of the file, and `range` the bytes that the
  /// request's `Range` header selects: nil for the whole file.
  case file(path: String, mime: String, total: UInt64, range: ClosedRange<UInt64>? = nil)
  /// `total` is the length of the file when the status is 416.
  case refused(status: Int, total: UInt64? = nil)
}

/// Handles the `reflect-asset` scheme: the files of the open graph's `assets/`
/// folder and archived X media. The URL is
/// `reflect-asset://localhost/<generation>/<path>` with the part after the
/// host percent-encoded as one segment.
///
/// The resolver decides which file a request names and which bytes its
/// `Range` header selects. The handler reads the file in chunks off the main
/// thread.
@MainActor
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
  typealias Resolve =
    @Sendable (_ requestPath: String, _ query: String?, _ range: String?) async
    -> AssetResolution

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
    let range = task.request.value(forHTTPHeaderField: "Range")

    Task {
      switch await resolve(requestPath, components.percentEncodedQuery, range) {
      case .refused(let status, let total):
        let headers = total.map { ["Content-Range": "bytes */\($0)"] } ?? [:]
        task.reply(SchemeReply(statusCode: status, headers: headers, body: Data()))
      case .file(let path, let mime, let total, let range):
        await Self.serve(path: path, mime: mime, total: total, range: range, to: task)
      }
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    tasks[ObjectIdentifier(urlSchemeTask)]?.stop()
  }

  private static func refuse(_ task: SchemeTask, status: Int) {
    task.reply(SchemeReply(statusCode: status, headers: [:], body: Data()))
  }

  private static func serve(
    path: String, mime: String, total: UInt64, range: ClosedRange<UInt64>?, to task: SchemeTask
  ) async {
    guard let file = await AssetFile.open(path: path) else {
      refuse(task, status: 404)
      return
    }
    guard file.length == total else {
      refuse(task, status: 500)
      return
    }
    var headers = ["Content-Type": mime, "Accept-Ranges": "bytes"]
    let selected = range ?? (total > 0 ? 0...(total - 1) : nil)
    headers["Content-Length"] = String(selected?.count ?? 0)
    if let range {
      headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound)/\(total)"
    }
    task.respond(status: range == nil ? 200 : 206, headers: headers)

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
