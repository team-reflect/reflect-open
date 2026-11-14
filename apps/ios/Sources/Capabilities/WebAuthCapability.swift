import AuthenticationServices
import TypesShared
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
    [ShellCommandName.webAuthStart.rawValue: { [self] request in await start(request) }]
  }

  /// `start {payload: {url, callbackScheme, ephemeral}}`: opens `url` and
  /// answers `{url}` with the callback URL, or `{}` when the user cancels.
  private func start(_ request: ShellRequest) async -> CoreReply {
    guard let payload = request.decodeArgs(WebAuthStartArgs.self)?.payload,
      let url = URL(string: payload.url)
    else {
      return .error(
        .parse(.init(message: "web-auth start takes {payload: {url, callbackScheme, ephemeral}}")))
    }
    do {
      let callbackURL = try await session.start(
        url: url, callbackScheme: payload.callbackScheme, ephemeral: payload.ephemeral)
      return .value(WebAuthCallback(url: callbackURL?.absoluteString))
    } catch {
      return .error(.io(.init(message: "web authentication failed: \(error.localizedDescription)")))
    }
  }
}
