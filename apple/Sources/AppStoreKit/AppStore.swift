#if os(iOS)
import Foundation
import StoreKit
public import UIKit

// FIXME: [review by claude-opus-5-5]: does this module earn its keep? `sync`, `presentOfferCodeRedeemSheet`, and `requestReview` are
//   one-line pass-throughs to StoreKit, `environment()` needs a real App Store / StoreKit env so it
//   has no tests, and the plugin still keeps its own `#available` guards. Net effect: one more layer
//   and one more product for no testability gain. Consider leaving `tauri-plugin-app-store` as it was
//   (revert this move), or move only `environment()` if a Swift shell (phase 1+) will need it.
/// StoreKit calls a host drives on behalf of the app.
public enum AppStoreClient {
  /// The install-channel probe. StoreKit 2's `AppTransaction.environment` is
  /// the official signal: `Production` for the App Store, `Sandbox` for
  /// TestFlight and development installs, `Xcode` for StoreKit-configuration
  /// runs. With no app transaction to read, the receipt path still separates a
  /// sandbox install from an App Store one; short of both, the probe returns
  /// nil rather than naming a channel, so a failure is never mistaken for a
  /// verdict.
  public static func environment() async -> String? {
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
    let isSandboxInstall = true
    #else
    let isSandboxInstall = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    #endif
    if isSandboxInstall {
      return "Sandbox"
    }
    return nil
  }

  /// Forces StoreKit to refetch transactions and subscription status from
  /// the App Store. May show Apple's sign-in prompt, so it runs only behind
  /// an explicit user action.
  @available(iOS 15.0, *)
  public static func sync() async throws {
    try await AppStore.sync()
  }

  /// Shows Apple's offer-code redemption sheet inside the app. A redeemed
  /// code lands as a transaction on `Transaction.updates`.
  @available(iOS 16.0, *)
  @MainActor
  public static func presentOfferCodeRedeemSheet(in scene: UIWindowScene) async throws {
    try await AppStore.presentOfferCodeRedeemSheet(in: scene)
  }

  /// Asks StoreKit for its review prompt. The system decides whether it
  /// shows (at most three times in 365 days on App Store installs, never in
  /// TestFlight) and reports nothing back.
  @available(iOS 16.0, *)
  @MainActor
  public static func requestReview(in scene: UIWindowScene) {
    AppStore.requestReview(in: scene)
  }
}
#endif
