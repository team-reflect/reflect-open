import StoreKit
import Tauri

/// The install-channel probe. StoreKit 2's `AppTransaction.environment` is
/// the official signal: `Production` for the App Store, `Sandbox` for
/// TestFlight and development installs, `Xcode` for StoreKit-configuration
/// runs. A probe that cannot reach an answer rejects rather than naming a
/// channel, so a failure is never mistaken for a verdict.
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
    invoke.reject("the app transaction is unavailable")
  }
}

@_cdecl("init_plugin_app_store")
func initPlugin() -> Plugin {
  return AppStorePlugin()
}
