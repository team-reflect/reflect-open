public import Foundation
import UniformTypeIdentifiers

/// Reads files from the bundled `Web/` folder, the output of the desktop app's Vite build.
public enum WebBundle {
  /// Reads the file at a URL path such as `/index.html` or `/assets/index-1a2b3c.js`.
  /// Returns 404 for a path outside `Web/` or a file that does not exist.
  @concurrent
  public static func reply(forPath path: String) async -> SchemeReply {
    let notFound = SchemeReply(
      statusCode: 404, headers: ["Content-Type": "text/plain"], body: Data("Not Found".utf8))
    let relativePath = path == "/" ? "index.html" : String(path.drop { $0 == "/" })
    guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web").standardizedFileURL
    else { return notFound }
    let file = root.appendingPathComponent(relativePath).standardizedFileURL
    guard file.path.hasPrefix(root.path + "/"), let body = try? Data(contentsOf: file) else {
      return notFound
    }

    var headers = [
      "Content-Type": UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
        ?? "application/octet-stream",
      "Content-Length": String(body.count),
      "Cache-Control": cacheControl(forPath: relativePath),
    ]
    if file.pathExtension == "html" {
      headers["Content-Security-Policy"] = ContentSecurityPolicy.header
    }
    return SchemeReply(statusCode: 200, headers: headers, body: body)
  }

  /// `index.html` is never cached. Vite puts a content hash in every file name
  /// under `assets/`, so those never change.
  private static func cacheControl(forPath relativePath: String) -> String {
    if relativePath == "index.html" {
      return "no-store"
    }
    if relativePath.hasPrefix("assets/") {
      return "public, max-age=31536000, immutable"
    }
    return "no-cache"
  }
}
