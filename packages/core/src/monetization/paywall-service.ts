import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { StorageService } from '../ports/storage-service.ts'
import type { ClassicAccessService, ClassicAccessState } from '../classic/classic-access-service.ts'
import type { AppStoreService } from '../ipc/app-store-service.ts'
import { IAP_PRODUCT_IDS, type IapProduct, type IapService } from '../ipc/iap-service.ts'
import { combineStores, deriveStore, type Store } from '../store.ts'
import type {
  AppStoreEnvironment,
  AppStoreEnvironmentService,
  AppStoreEnvironmentState,
} from './app-store-environment-service.ts'
import type {
  ActiveSubscription,
  SubscriptionService,
  SubscriptionState,
} from './subscription-service.ts'

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
   * Whether to render the paywall. An unsettled subscription check reads
   * `hide` so verification never blocks app startup. It subscribes to its
   * inputs only while it has subscribers.
   */
  readonly gate: Store<PaywallGate>
  /**
   * Whether the user asked to see the paywall in this session.
   */
  readonly requested: Store<boolean>
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

/**
 * The paywall visibility on iOS for the given inputs.
 */
function computeGate(
  active: SubscriptionState,
  classic: ClassicAccessState,
  environment: AppStoreEnvironmentState,
  requested: boolean,
): PaywallGate {
  if (active.value !== null || classic.active) {
    return 'hide'
  }
  // Ahead of the pending checks on purpose: a build that already knows it is
  // not from the App Store drops into the notes without waiting on StoreKit.
  if (!isAppStoreInstall(environment.value) && !requested) {
    return 'hide'
  }
  return active.isLoading || classic.isLoading ? 'hide' : 'show'
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
  readonly gate: Store<PaywallGate>
  readonly requested: Store<boolean>

  constructor(deps: PaywallServiceDeps) {
    this.#deps = deps
    const { subscription, classicAccess, appStoreEnvironment, platform, storage } = deps
    const stored: Store<string | null> = {
      get: () => storage.session.get(PAYWALL_REQUESTED_STORAGE_KEY),
      subscribe: (listener) => storage.session.subscribe(PAYWALL_REQUESTED_STORAGE_KEY, listener),
    }
    this.requested = deriveStore(stored, (value) => value === 'true')
    this.gate = combineStores(
      [subscription, classicAccess, appStoreEnvironment, this.requested],
      (active, classic, environment, requested) => {
        return platform.appPlatform === 'ios'
          ? computeGate(active, classic, environment, requested)
          : 'hide'
      },
    )
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
