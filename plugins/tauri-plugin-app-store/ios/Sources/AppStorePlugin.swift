import StoreKit
import Tauri

/// The install-channel probe. StoreKit 2's `AppTransaction.environment` is
/// the official signal: `Production` for the App Store, `Sandbox` for
/// TestFlight and development installs, `Xcode` for StoreKit-configuration
/// runs. Anything short of a verified answer resolves as `Production`, so a
/// failure can never misclassify a paying App Store customer as a tester.
class AppStorePlugin: Plugin {
  // `async throws` (never throws): Tauri dispatches async commands through
  // the `command:completionHandler:` selector with an `(NSError?) -> Void`
  // block, the bridge only a throwing async method generates; a plain
  // `async` method would take a zero-argument block and mismatch that ABI.
  @objc public func getEnvironment(_ invoke: Invoke) async throws {
    if #available(iOS 16.0, *) {
      if let result = try? await AppTransaction.shared,
        case .verified(let transaction) = result
      {
        invoke.resolve(["environment": transaction.environment.rawValue])
        return
      }
    }
    invoke.resolve(["environment": "Production"])
  }
}

@_cdecl("init_plugin_app_store")
func initPlugin() -> Plugin {
  return AppStorePlugin()
}
