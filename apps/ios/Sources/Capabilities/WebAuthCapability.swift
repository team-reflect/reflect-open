import AuthenticationServices
import WebHostKit

/// The `plugin:web-auth` commands: the system web sign-in session.
@MainActor
final class WebAuthCapability: NSObject, ASWebAuthenticationPresentationContextProviding {
  private let anchor: () -> ASPresentationAnchor
  /// A session cancels itself when it is deallocated.
  private var session: ASWebAuthenticationSession?

  /// `anchor` returns the window that presents the sign-in sheet.
  init(anchor: @escaping () -> ASPresentationAnchor) {
    self.anchor = anchor
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
    let result: Result<URL?, Error> = await withCheckedContinuation { continuation in
      let session = ASWebAuthenticationSession(
        url: payload.url, callbackURLScheme: payload.callbackScheme
      ) { callbackURL, error in
        if let error, (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
          continuation.resume(returning: .failure(error))
        } else {
          continuation.resume(returning: .success(callbackURL))
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = payload.ephemeral
      self.session = session
      if !session.start() {
        continuation.resume(returning: .failure(URLError(.cannotLoadFromNetwork)))
      }
    }
    session = nil
    switch result {
    case .success(let callbackURL):
      return .value(Response(url: callbackURL?.absoluteString))
    case .failure(let error):
      return .error(
        kind: "io", message: "web authentication failed: \(error.localizedDescription)")
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    anchor()
  }
}
