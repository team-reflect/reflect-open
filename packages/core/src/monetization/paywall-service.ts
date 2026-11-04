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
import type { InstallClockService, InstallClockState } from './install-clock-service.ts'
import type { PaywallPhase } from './paywall-phase.ts'
import type {
  ActiveSubscription,
  SubscriptionService,
  SubscriptionState,
} from './subscription-service.ts'

/**
 * Session-wide, so the request survives leaving and re-entering Settings.
 */
export const PAYWALL_REQUESTED_STORAGE_KEY = 'reflect.paywall-requested'

/**
 * The install clock's `dayIndex` on which the skippable paywall last opened.
 */
export const PAYWALL_SKIPPABLE_SHOWN_DAY_STORAGE_KEY = 'reflect.paywall.skippable-shown-day'

/**
 * A simulated phase for QA, for this session only.
 */
export const PAYWALL_PHASE_OVERRIDE_STORAGE_KEY = 'reflect.paywall.phase-override'

/**
 * Whether the paywall covers the app, and the actions that lift it.
 */
export interface PaywallService {
  /**
   * Whether to render the paywall, and whether it can be closed. An unsettled
   * check reads `hidden` so verification never blocks app startup. It
   * subscribes to its inputs only while it has subscribers.
   */
  readonly gate: Store<PaywallPhase>
  /**
   * Whether the skippable paywall is open in this session, because the user
   * asked for it or because it opened on its own.
   */
  readonly requested: Store<boolean>
  setRequested: (next: boolean) => void
  /**
   * Records that the skippable paywall opened today and keeps it open until
   * {@link PaywallService.dismissSkippable}.
   */
  markSkippableShown: () => void
  /**
   * Closes the skippable paywall.
   */
  dismissSkippable: () => void
  /**
   * The simulated phase, or `null` for the real one.
   */
  readonly phaseOverride: Store<PaywallPhase | null>
  /**
   * Sets the simulated phase and forgets that the skippable paywall opened today.
   */
  setPhaseOverride: (next: PaywallPhase | null) => void
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

interface GateInputs {
  readonly active: SubscriptionState
  readonly classic: ClassicAccessState
  readonly environment: AppStoreEnvironmentState
  readonly clock: InstallClockState
  readonly requested: boolean
  readonly shownDay: string | null
  readonly override: PaywallPhase | null
}

/**
 * The paywall visibility on iOS for the given inputs.
 */
function computeGate({
  active,
  classic,
  environment,
  clock,
  requested,
  shownDay,
  override,
}: GateInputs): PaywallPhase {
  if (active.value !== null || classic.active) {
    return 'hidden'
  }
  // Ahead of the pending checks on purpose: a build that already knows it is
  // not from the App Store drops into the notes without waiting on StoreKit.
  if (override === null && !isAppStoreInstall(environment.value)) {
    return requested ? 'skippable' : 'hidden'
  }
  if (active.isLoading || classic.isLoading || clock.isLoading) {
    return 'hidden'
  }
  const phase = override ?? clock.phase
  if (phase === 'required') {
    return 'required'
  }
  if (requested || (phase === 'skippable' && shownDay !== String(clock.dayIndex))) {
    return 'skippable'
  }
  return 'hidden'
}

export interface PaywallServiceDeps {
  readonly subscription: SubscriptionService
  readonly classicAccess: ClassicAccessService
  readonly appStoreEnvironment: AppStoreEnvironmentService
  readonly installClock: InstallClockService
  readonly iap: IapService
  readonly appStore: AppStoreService
  readonly platform: PlatformFacts
  readonly storage: StorageService
}

function selectIsRequested(value: string | null): boolean {
  return value === 'true'
}

function selectPhase(value: string | null): PaywallPhase | null {
  return value === 'hidden' || value === 'skippable' || value === 'required' ? value : null
}

class PaywallServiceImpl implements PaywallService {
  readonly #deps: PaywallServiceDeps
  readonly gate: Store<PaywallPhase>
  readonly requested: Store<boolean>
  readonly phaseOverride: Store<PaywallPhase | null>

  constructor(deps: PaywallServiceDeps) {
    this.#deps = deps
    const { subscription, classicAccess, appStoreEnvironment, installClock, platform, storage } =
      deps
    this.requested = deriveStore(
      storage.session.store(PAYWALL_REQUESTED_STORAGE_KEY),
      selectIsRequested,
    )
    this.phaseOverride = deriveStore(
      storage.session.store(PAYWALL_PHASE_OVERRIDE_STORAGE_KEY),
      selectPhase,
    )
    this.gate = combineStores(
      [
        subscription,
        classicAccess,
        appStoreEnvironment,
        installClock,
        this.requested,
        storage.local.store(PAYWALL_SKIPPABLE_SHOWN_DAY_STORAGE_KEY),
        this.phaseOverride,
      ],
      (active, classic, environment, clock, requested, shownDay, override) => {
        return platform.appPlatform === 'ios'
          ? computeGate({ active, classic, environment, clock, requested, shownDay, override })
          : 'hidden'
      },
    )
  }

  readonly setRequested = (next: boolean): void => {
    this.#deps.storage.session.set(PAYWALL_REQUESTED_STORAGE_KEY, next ? 'true' : 'false')
  }

  readonly markSkippableShown = (): void => {
    // Open first, so the day never closes the paywall it records.
    this.setRequested(true)
    this.#deps.storage.local.set(
      PAYWALL_SKIPPABLE_SHOWN_DAY_STORAGE_KEY,
      String(this.#deps.installClock.get().dayIndex),
    )
  }

  readonly dismissSkippable = (): void => {
    // Records the day again, so a paywall left open into the next day still closes.
    this.#deps.storage.local.set(
      PAYWALL_SKIPPABLE_SHOWN_DAY_STORAGE_KEY,
      String(this.#deps.installClock.get().dayIndex),
    )
    this.setRequested(false)
  }

  readonly setPhaseOverride = (next: PaywallPhase | null): void => {
    const { storage } = this.#deps
    storage.local.set(PAYWALL_SKIPPABLE_SHOWN_DAY_STORAGE_KEY, null)
    this.setRequested(false)
    storage.session.set(PAYWALL_PHASE_OVERRIDE_STORAGE_KEY, next)
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
