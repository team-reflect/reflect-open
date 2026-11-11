public import Foundation

/// The pages that may call the privileged routes of the `reflect-app` scheme.
///
/// A web view also runs documents that are not the web app: embeds in
/// subframes, and any page a navigation reaches. Their requests arrive at the
/// scheme handler like the app's own, so each request is checked by the
/// headers that WebKit sets and page script cannot change:
///
/// - A cross-origin request carries `Origin`. It must be the bundled app's
///   origin or the dev server's. An opaque origin (`null`) is refused.
/// - A same-origin request from the bundled app carries no `Origin`. It is
///   trusted only by its `Referer`, which must be a URL of the bundled app
///   or the dev server.
/// - A request with neither header is refused.
public struct TrustedCallers: Sendable {
  /// The origin of the bundled web app.
  public static let appOrigin = "reflect-app://localhost"

  /// The origin of a dev server page that hosts the web app, if any.
  public var devOrigin: String?

  public init(devOrigin: String? = nil) {
    self.devOrigin = devOrigin
  }

  /// The origin of the caller when it is trusted, else nil.
  public func trustedOrigin(of request: URLRequest) -> String? {
    let origin =
      request.value(forHTTPHeaderField: "Origin")
      ?? request.value(forHTTPHeaderField: "Referer").flatMap(URL.init(string:))?.webOrigin
    guard let origin, origin == Self.appOrigin || origin == devOrigin else { return nil }
    return origin
  }

  /// The CORS headers that let the dev server page read a response. The
  /// bundled web app is same-origin and needs none.
  public func corsHeaders(for request: URLRequest) -> [String: String] {
    guard let devOrigin, trustedOrigin(of: request) == devOrigin else { return [:] }
    return [
      "Access-Control-Allow-Origin": devOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "x-reflect-response",
      "Vary": "Origin",
    ]
  }
}
