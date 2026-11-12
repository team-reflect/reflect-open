import Foundation
import StoreKit

/// The install-channel probe. StoreKit 2's `AppTransaction.environment` is
/// the official signal: `Production` for the App Store, `Sandbox` for
/// TestFlight and development installs, `Xcode` for StoreKit-configuration
/// runs. With no app transaction to read, the receipt path still separates a
/// sandbox install from an App Store one; short of both, the probe answers
/// nil rather than naming a channel, so a failure is never mistaken for a
/// verdict.
public enum AppStoreEnvironment {
  /// The environment of this install, or nil when StoreKit cannot tell.
  public static func current() async -> String? {
    if #available(iOS 16.0, *), let result = try? await AppTransaction.shared {
      // An unverified payload names the same environment as a verified one:
      // StoreKit lists it beside a thrown error as a case for
      // `AppTransaction.refresh()`, not as a wrong answer.
      switch result {
      case .verified(let transaction), .unverified(let transaction, _):
        return transaction.environment.rawValue
      }
    }
    // Reading an app transaction can need the network and an authenticated
    // App Store account; the receipt path needs neither, and names a sandbox
    // install `sandboxReceipt` where an App Store install is `receipt`. The
    // property is deprecated for Swift in favor of the call above, which is
    // exactly the call that just failed.
    //
    // A simulator has no App Store account and names its receipt `receipt`,
    // so it fails both checks; it is always a development install.
    #if targetEnvironment(simulator)
    return "Sandbox"
    #else
    let isSandboxInstall = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    return isSandboxInstall ? "Sandbox" : nil
    #endif
  }
}
