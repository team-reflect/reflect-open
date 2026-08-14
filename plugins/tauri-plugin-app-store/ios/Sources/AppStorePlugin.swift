import StoreKit
import Tauri

/// The App Store environment probe.
///
/// `AppTransaction.shared` is StoreKit 2's signed app-level transaction; its
/// `environment` field is the official "which channel installed this build"
/// signal: `Production` for the App Store, `Sandbox` for TestFlight and
/// development installs, `Xcode` for StoreKit-configuration runs. StoreKit
/// normally answers from its local cache, but a cold first call can need the
/// network; anything short of a verified answer resolves as `Production`, so
/// a failure can gate features closed but never misclassify a paying App
/// Store customer as a tester.
class AppStorePlugin: Plugin {
  // `async throws` (never throws): Tauri's dispatcher invokes async commands
  // through the `command:completionHandler:` ObjC bridge and hands it an
  // `(NSError?) -> Void` block, which is the bridge a throwing async method
  // generates; a non-throwing one would take a zero-argument block instead
  // and mismatch that ABI.
  @objc public func getEnvironment(_ invoke: Invoke) async throws {
    guard let result = try? await AppTransaction.shared,
      case .verified(let transaction) = result
    else {
      invoke.resolve(["environment": "Production"])
      return
    }
    invoke.resolve(["environment": transaction.environment.rawValue])
  }
}

@_cdecl("init_plugin_app_store")
func initPlugin() -> Plugin {
  return AppStorePlugin()
}
