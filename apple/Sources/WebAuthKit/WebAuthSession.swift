public import AuthenticationServices

/// The system web sign-in sheet (`ASWebAuthenticationSession`).
@MainActor
public final class WebAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
  private let anchor: @MainActor () -> ASPresentationAnchor
  /// A session cancels itself when it is deallocated.
  private var session: ASWebAuthenticationSession?

  /// `anchor` returns the window that presents the sign-in sheet.
  public init(anchor: @escaping @MainActor () -> ASPresentationAnchor) {
    self.anchor = anchor
  }

  /// Opens `url`, usually an OAuth authorize URL, and returns the callback
  /// URL with its query, or nil when the user cancels. A navigation to
  /// `callbackScheme` (without `://`) ends the session. An `ephemeral`
  /// session shares no cookies or website data with Safari.
  public func start(url: URL, callbackScheme: String, ephemeral: Bool) async throws -> URL? {
    let result: Result<URL?, any Error> = await withCheckedContinuation { continuation in
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) {
        callbackURL, error in
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
      session.prefersEphemeralWebBrowserSession = ephemeral
      self.session = session
      if !session.start() {
        continuation.resume(returning: .failure(URLError(.cannotLoadFromNetwork)))
      }
    }
    session = nil
    return try result.get()
  }

  public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    anchor()
  }
}
