import AppStoreKit
import Foundation
import StoreKit
import Tauri
import UIKit

/// The App Store commands of the Tauri app.
class AppStorePlugin: Plugin {
  // `async throws` (never throws): Tauri dispatches async commands through
  // the `command:completionHandler:` selector with an `(NSError?) -> Void`
  // block, the bridge only a throwing async method generates; a plain
  // `async` method would take a zero-argument block and mismatch that ABI.
  @objc public func getEnvironment(_ invoke: Invoke) async throws {
    guard let environment = await AppStoreEnvironment.current() else {
      invoke.reject("the app transaction is unavailable")
      return
    }
    invoke.resolve(["environment": environment])
  }

  /// Forces StoreKit to refetch transactions and subscription status from
  /// the App Store. May show Apple's sign-in prompt, so it runs only behind
  /// an explicit user action.
  @objc public func sync(_ invoke: Invoke) async throws {
    guard #available(iOS 15.0, *) else {
      invoke.reject("AppStore.sync needs iOS 15")
      return
    }
    do {
      try await AppStore.sync()
      invoke.resolve()
    } catch {
      invoke.reject("AppStore.sync failed: \(error.localizedDescription)")
    }
  }

  /// Shows Apple's offer-code redemption sheet inside the app. A redeemed
  /// code lands as a transaction on `Transaction.updates`.
  @MainActor
  @objc public func presentOfferCodeRedeemSheet(_ invoke: Invoke) async throws {
    guard #available(iOS 16.0, *) else {
      invoke.reject("presentOfferCodeRedeemSheet needs iOS 16")
      return
    }
    guard
      let scene = UIApplication.shared.connectedScenes
        .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
    else {
      invoke.reject("no active window scene")
      return
    }
    do {
      try await AppStore.presentOfferCodeRedeemSheet(in: scene)
      invoke.resolve()
    } catch {
      invoke.reject("presentOfferCodeRedeemSheet failed: \(error.localizedDescription)")
    }
  }

  /// Asks StoreKit for its review prompt. The system decides whether it
  /// shows (at most three times in 365 days on App Store installs, never in
  /// TestFlight) and reports nothing back.
  @MainActor
  @objc public func requestReview(_ invoke: Invoke) async throws {
    // The Swift package says iOS 16, but the TestFlight build compiles this
    // file with a lower deployment target, so the check must stay.
    guard #available(iOS 16.0, *) else {
      invoke.reject("requestReview needs iOS 16")
      return
    }
    guard
      let scene = UIApplication.shared.connectedScenes
        .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
    else {
      invoke.reject("no active window scene")
      return
    }
    AppStore.requestReview(in: scene)
    invoke.resolve()
  }
}

@_cdecl("init_plugin_app_store")
public func initPlugin() -> Plugin {
  return AppStorePlugin()
}
