import AuthenticationServices
import WebAuthKit
import WebHostKit

/// The `plugin:web-auth` commands: the system web sign-in session.
@MainActor
final class WebAuthCapability {
  private let session: WebAuthSession

  /// `anchor` returns the window that presents the sign-in sheet.
  init(anchor: @escaping @MainActor () -> ASPresentationAnchor) {
    session = WebAuthSession(anchor: anchor)
  }

  var commands: [String: ShellCommand] {
    ["plugin:web-auth|start": { [self] request in await start(request) }]
  }

  /// `start {payload: {url, callbackScheme, ephemeral}}`: opens `url` and
  /// answers `{url}` with the callback URL, or `{}` when the user cancels.
  private func start(_ request: ShellRequest) async -> CoreReply {
    struct Args: Decodable {
      struct Payload: Decodable {
        var url: URL
        var callbackScheme: String
        var ephemeral: Bool
      }
      var payload: Payload
    }
    struct Response: Encodable {
      var url: String?
    }
    guard let payload = request.decodeArgs(Args.self)?.payload else {
      return .error(
        kind: "parse", message: "web-auth start takes {payload: {url, callbackScheme, ephemeral}}")
    }
    do {
      let callbackURL = try await session.start(
        url: payload.url, callbackScheme: payload.callbackScheme, ephemeral: payload.ephemeral)
      return .value(Response(url: callbackURL?.absoluteString))
    } catch {
      return .error(
        kind: "io", message: "web authentication failed: \(error.localizedDescription)")
    }
  }
}
