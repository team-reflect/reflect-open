import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { StorageService } from '../ports/storage-service.ts'
import type { ClassicAccessService } from '../classic/classic-access-service.ts'
import type { AppStoreService } from '../ipc/app-store-service.ts'
import { IAP_PRODUCT_IDS, type IapProduct, type IapService } from '../ipc/iap-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type {
  AppStoreEnvironment,
  AppStoreEnvironmentService,
} from './app-store-environment-service.ts'
import type { ActiveSubscription, SubscriptionService } from './subscription-service.ts'

/**
 * Paywall visibility: `show` replaces the app; `hide` leaves the app visible.
 */
export type PaywallGate = 'show' | 'hide'

/**
 * Session-wide, so the request survives leaving and re-entering Settings.
 */
export const PAYWALL_REQUESTED_STORAGE_KEY = 'reflect.paywall-requested'

/**
 * Whether the paywall replaces the app, and the actions that lift it.
 */
export interface PaywallService {
  /**
   * Whether to render the paywall. An unsettled subscription check returns
   * `hide` so verification never blocks app startup.
   */
  gate: () => PaywallGate
  /**
   * Calls `listener` whenever `gate()` or `requested()` may have changed.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Whether the user asked to see the paywall in this session.
   */
  requested: () => boolean
  setRequested: (next: boolean) => void
  /**
   * The store's offers for the yearly and monthly plans.
   */
  products(): Promise<IapProduct[]>
  /**
   * Runs the purchase sheet for `productId`, then looks the subscription up again.
   */
  purchase(productId: string): Promise<void>
  /**
   * Syncs with the App Store, then resolves the subscription StoreKit now reports.
   */
  restore(): Promise<ActiveSubscription>
  /**
   * Presents the offer-code sheet, then looks the subscription up again.
   */
  redeemCode(): Promise<void>
}

/**
 * Whether the paywall may block this install. Only a definite `Sandbox`
 * (TestFlight or a development install) or `Xcode` (a StoreKit-configuration
 * run) lifts the gate: an unfinished probe, a failed probe, and an
 * unrecognized value all count as an App Store install. The paywall's job is
 * to be shown, so a broken probe must never hand the customer base a free app.
 */
function isAppStoreInstall(environment: AppStoreEnvironment): boolean {
  return environment !== 'Sandbox' && environment !== 'Xcode'
}

export interface PaywallServiceDeps {
  readonly subscription: SubscriptionService
  readonly classicAccess: ClassicAccessService
  readonly appStoreEnvironment: AppStoreEnvironmentService
  readonly iap: IapService
  readonly appStore: AppStoreService
  readonly platform: PlatformFacts
  readonly storage: StorageService
}

class PaywallServiceImpl implements PaywallService {
  readonly #deps: PaywallServiceDeps

  constructor(deps: PaywallServiceDeps) {
    this.#deps = deps
  }

  readonly gate = (): PaywallGate => {
    const { subscription, classicAccess, appStoreEnvironment, platform } = this.#deps
    if (platform.appPlatform !== 'ios') {
      return 'hide'
    }
    const active = subscription.getState()
    const classic = classicAccess.getState()
    if (active.value !== null || classic.active) {
      return 'hide'
    }
    // Ahead of the pending checks on purpose: a build that already knows it is
    // not from the App Store drops into the notes without waiting on StoreKit.
    if (!isAppStoreInstall(appStoreEnvironment.getState().value) && !this.requested()) {
      return 'hide'
    }
    return active.isLoading || classic.isLoading ? 'hide' : 'show'
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    const { subscription, classicAccess, appStoreEnvironment, storage } = this.#deps
    const unlisten = [
      subscription.subscribe(listener),
      classicAccess.subscribe(listener),
      appStoreEnvironment.subscribe(listener),
      storage.session.subscribe(PAYWALL_REQUESTED_STORAGE_KEY, listener),
    ]
    return () => {
      for (const stop of unlisten) {
        stop()
      }
    }
  }

  readonly requested = (): boolean => {
    return this.#deps.storage.session.get(PAYWALL_REQUESTED_STORAGE_KEY) === 'true'
  }

  readonly setRequested = (next: boolean): void => {
    this.#deps.storage.session.set(PAYWALL_REQUESTED_STORAGE_KEY, next ? 'true' : 'false')
  }

  products(): Promise<IapProduct[]> {
    return this.#deps.iap.getProducts([IAP_PRODUCT_IDS.yearly, IAP_PRODUCT_IDS.monthly])
  }

  async purchase(productId: string): Promise<void> {
    await this.#deps.iap.purchase(productId)
    this.#deps.subscription.invalidate()
  }

  async restore(): Promise<ActiveSubscription> {
    await this.#deps.appStore.sync()
    return await this.#deps.subscription.refetch()
  }

  async redeemCode(): Promise<void> {
    await this.#deps.appStore.presentOfferCodeRedeemSheet()
    // A redeemed code normally arrives as a purchaseUpdated event; the
    // refetch here covers a sheet that closed without emitting one.
    this.#deps.subscription.invalidate()
  }
}

export function createPaywallService(deps: PaywallServiceDeps): PaywallService {
  return new PaywallServiceImpl(deps)
}
