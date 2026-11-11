import AuthenticationServices
import Tauri
import UIKit
import WebAuthKit

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

class WebAuthPlugin: Plugin {
  @MainActor
  private lazy var session = WebAuthSession {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }

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
    do {
      let callbackURL = try await session.start(
        url: url, callbackScheme: args.callbackScheme, ephemeral: args.ephemeral)
      invoke.resolve(StartResponse(url: callbackURL?.absoluteString))
    } catch {
      invoke.reject("web authentication failed: \(error.localizedDescription)")
    }
  }
}

@_cdecl("init_plugin_web_auth")
public func initPlugin() -> Plugin {
  return WebAuthPlugin()
}
