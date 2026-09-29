import AuthenticationServices
import Tauri
import UIKit

class StartArgs: Decodable {
  /// The page to open, usually an OAuth authorize URL.
  let url: String
  /// The URL scheme (without `://`) whose navigation ends the session, e.g. `reflect`.
  let callbackScheme: String
  /// When true, the session shares no cookies or website data with Safari.
  let ephemeral: Bool
}

struct StartResponse: Encodable {
  /// The full callback URL including its query, or nil when the user cancelled.
  let url: String?
}

class WebAuthPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  // ASWebAuthenticationSession cancels itself when deallocated.
  private var session: ASWebAuthenticationSession?

  /// Resolves the callback URL, or no URL when the user cancels.
  ///
  /// `async throws` (never throws): Tauri dispatches async commands through a
  /// completion-handler selector that only a throwing async method generates.
  @MainActor
  @objc public func start(_ invoke: Invoke) async throws {
    let args = try invoke.parseArgs(StartArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("invalid authentication URL")
      return
    }
    let result: Result<URL?, Error> = await withCheckedContinuation { continuation in
      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: args.callbackScheme
      ) { callbackURL, error in
        if let callbackURL {
          continuation.resume(returning: .success(callbackURL))
        } else if let error = error as? ASWebAuthenticationSessionError,
          error.code == .canceledLogin
        {
          continuation.resume(returning: .success(nil))
        } else {
          continuation.resume(returning: .failure(error ?? URLError(.unknown)))
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = args.ephemeral
      self.session = session
      if !session.start() {
        continuation.resume(returning: .failure(URLError(.cannotLoadFromNetwork)))
      }
    }
    session = nil
    switch result {
    case .success(let callbackURL):
      invoke.resolve(StartResponse(url: callbackURL?.absoluteString))
    case .failure(let error):
      invoke.reject("web authentication failed: \(error.localizedDescription)")
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_web_auth")
func initPlugin() -> Plugin {
  return WebAuthPlugin()
}
