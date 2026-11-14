import type { MaybePromise } from '@reflect/utils'
import type { IpcBridgeService } from './ipc-service.ts'

/**
 * The service over the `plugin:app-store` commands, the install-channel
 * probe (`apps/ios/Sources/Capabilities/StoreCapability.swift`).
 */

/**
 * The App Store install channel and its restore and redeem flows.
 */
export interface AppStoreService {
  /**
   * Which channel installed this build, per StoreKit 2's
   * `AppTransaction.environment`: `'Production'` (App Store), `'Sandbox'`
   * (TestFlight or a development install), or `'Xcode'` (a
   * StoreKit-configuration run). Rejects when the probe cannot answer, so an
   * unanswered probe stays distinguishable from a named channel.
   */
  environment(): MaybePromise<string>
  /**
   * Force StoreKit to refetch transactions from the App Store
   * (`AppStore.sync()`). Apple may show a sign-in prompt, so call it only
   * from an explicit user action such as Restore Purchases.
   */
  sync(): MaybePromise<void>
  /**
   * Show Apple's in-app offer-code redemption sheet. A redeemed code arrives
   * through the iap plugin's `purchaseUpdated` event, not through this call's
   * result, which resolves as soon as the sheet is presented.
   */
  presentOfferCodeRedeemSheet(): MaybePromise<void>
  /**
   * Ask StoreKit for its review prompt. The system decides whether it shows:
   * at most three times in 365 days on an App Store install, every time in a
   * development build, and never in TestFlight. Nothing reports whether it
   * showed or what the user chose.
   */
  requestReview(): MaybePromise<void>
}

export interface AppStoreServiceDeps {
  readonly ipc: IpcBridgeService
}

class AppStoreServiceImpl implements AppStoreService {
  readonly #deps: AppStoreServiceDeps

  constructor(deps: AppStoreServiceDeps) {
    this.#deps = deps
  }

  async environment(): Promise<string> {
    return (await this.#deps.ipc.call('plugin:app-store|get_environment', {})).environment
  }

  async sync(): Promise<void> {
    await this.#deps.ipc.call('plugin:app-store|sync', {})
  }

  async presentOfferCodeRedeemSheet(): Promise<void> {
    await this.#deps.ipc.call('plugin:app-store|present_offer_code_redeem_sheet', {})
  }

  async requestReview(): Promise<void> {
    await this.#deps.ipc.call('plugin:app-store|request_review', {})
  }
}

export function createAppStoreService(deps: AppStoreServiceDeps): AppStoreService {
  return new AppStoreServiceImpl(deps)
}
