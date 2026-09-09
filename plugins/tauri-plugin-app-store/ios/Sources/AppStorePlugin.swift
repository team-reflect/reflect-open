import Foundation
import StoreKit
import Tauri

/// The install-channel probe. StoreKit 2's `AppTransaction.environment` is
/// the official signal: `Production` for the App Store, `Sandbox` for
/// TestFlight and development installs, `Xcode` for StoreKit-configuration
/// runs. With no app transaction to read, the receipt path still separates a
/// sandbox install from an App Store one; short of both, the probe rejects
/// rather than naming a channel, so a failure is never mistaken for a verdict.
class AppStorePlugin: Plugin {
  // `async throws` (never throws): Tauri dispatches async commands through
  // the `command:completionHandler:` selector with an `(NSError?) -> Void`
  // block, the bridge only a throwing async method generates; a plain
  // `async` method would take a zero-argument block and mismatch that ABI.
  @objc public func getEnvironment(_ invoke: Invoke) async throws {
    if #available(iOS 16.0, *), let result = try? await AppTransaction.shared {
      // An unverified payload names the same environment as a verified one:
      // StoreKit lists it beside a thrown error as a case for
      // `AppTransaction.refresh()`, not as a wrong answer.
      switch result {
      case .verified(let transaction), .unverified(let transaction, _):
        invoke.resolve(["environment": transaction.environment.rawValue])
        return
      }
    }
    // Reading an app transaction can need the network and an authenticated
    // App Store account; the receipt path needs neither, and names a sandbox
    // install `sandboxReceipt` where an App Store install is `receipt`. The
    // property is deprecated for Swift in favor of the call above, which is
    // exactly the call that just failed.
    if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" {
      invoke.resolve(["environment": "Sandbox"])
      return
    }
    invoke.reject("the app transaction is unavailable")
  }
}

@_cdecl("init_plugin_app_store")
func initPlugin() -> Plugin {
  return AppStorePlugin()
}
