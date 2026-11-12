import Foundation
import StoreKit

/// The install-channel probe. StoreKit 2's `AppTransaction.environment` is
/// the official signal: `Production` for the App Store, `Sandbox` for
/// TestFlight and development installs, `Xcode` for StoreKit-configuration
/// runs. With no app transaction to read, the probe answers nil rather than
/// naming a channel, so a failure is never mistaken for a verdict.
public enum AppStoreEnvironment {
  /// The environment of this install, or nil when StoreKit cannot tell.
  public static func current() async -> String? {
    if let result = try? await AppTransaction.shared {
      // An unverified payload names the same environment as a verified one:
      // StoreKit lists it beside a thrown error as a case for
      // `AppTransaction.refresh()`, not as a wrong answer.
      switch result {
      case .verified(let transaction), .unverified(let transaction, _):
        return transaction.environment.rawValue
      }
    }
    // A simulator has no App Store account, so it has no app transaction; it
    // is always a development install.
    #if targetEnvironment(simulator)
    return "Sandbox"
    #else
    return nil
    #endif
  }
}
