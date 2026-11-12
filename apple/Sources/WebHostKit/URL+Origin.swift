public import Foundation

extension URL {
  /// The port, or the default of `http` and `https` for a URL that names none.
  var effectivePort: Int? {
    port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : nil)
  }

  /// The origin as the `Origin` header spells it, such as
  /// `http://localhost:1420`: without the default port of the scheme.
  public var webOrigin: String? {
    guard let scheme, let rawHost = host, !rawHost.isEmpty else { return nil }
    let host = rawHost.contains(":") ? "[\(rawHost)]" : rawHost
    let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
    guard let port, port != defaultPort else { return "\(scheme)://\(host)" }
    return "\(scheme)://\(host):\(port)"
  }
}
