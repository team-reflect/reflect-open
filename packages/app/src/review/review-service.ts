import {
  deriveStore,
  errorMessage,
  marketingVersion,
  type AppStoreEnvironment,
  type ClockService,
  type CoreServices,
  type LoggerService,
  type MobileServices,
  type PlatformFacts,
  type StorageService,
  type Store,
} from '@reflect/core'
import type { OpenerService } from '../app/opener-service.ts'

/**
 * When the user last tapped Rate Reflect on the review page, in epoch milliseconds.
 */
export const REVIEW_REQUESTED_AT_STORAGE_KEY = 'reflect.review.requested-at'

/**
 * Forces the review page on for QA, for this session only.
 */
export const REVIEW_OVERRIDE_STORAGE_KEY = 'reflect.review.override'

/**
 * How long the review page stays away after Rate Reflect, matching Apple's
 * prompt quota period.
 */
export const REVIEW_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000

export const WRITE_REVIEW_URL = 'https://apps.apple.com/app/id6787385615?action=write-review'

const FEEDBACK_EMAIL = 'support@reflect.app'

/**
 * Everything {@link decideAskForReview} reads.
 */
export interface ReviewInputs {
  /**
   * The current marketing version is marked for a review request.
   */
  readonly marked: boolean
  readonly environment: AppStoreEnvironment
  /**
   * The user has an App Store subscription or Reflect Classic access.
   */
  readonly paid: boolean
  readonly requestedAt: number | null
  readonly now: number
  readonly override: boolean
}

/**
 * Whether the review page should follow What's New for the given inputs.
 */
export function decideAskForReview(inputs: ReviewInputs): boolean {
  if (inputs.override) {
    return true
  }
  const cooledDown =
    inputs.requestedAt === null || inputs.now - inputs.requestedAt >= REVIEW_COOLDOWN_MS
  return inputs.marked && inputs.environment === 'Production' && inputs.paid && cooledDown
}

function selectIsOverride(value: string | null): boolean {
  return value === 'true'
}

function parseRequestedAt(value: string | null): number | null {
  const time = value === null ? Number.NaN : Number(value)
  return Number.isFinite(time) ? time : null
}

/**
 * The App Store review request on iOS, and the rate and feedback links.
 */
export interface ReviewService {
  /**
   * Whether QA forces the review page on in this session.
   */
  readonly override: Store<boolean>
  setOverride: (next: boolean) => void
  /**
   * Whether the review page should follow What's New right now.
   */
  shouldAsk(): boolean
  /**
   * Asks StoreKit for its review prompt and starts the cooldown.
   */
  requestReview: () => void
  /**
   * Opens the App Store page that writes a review.
   */
  writeReview: () => void
  /**
   * Opens a feedback email to support.
   */
  sendFeedback: () => void
}

export interface ReviewServiceDeps {
  readonly storage: StorageService
  readonly clock: ClockService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
  readonly opener: OpenerService
  readonly classicAccess: CoreServices['classicAccess']
  /**
   * The StoreKit services; `null` where there is no App Store.
   */
  readonly mobile: Pick<MobileServices, 'appStore' | 'appStoreEnvironment' | 'subscription'> | null
  /**
   * The marketing versions that ask for a review.
   */
  readonly versions: ReadonlySet<string>
}

class ReviewServiceImpl implements ReviewService {
  readonly #deps: ReviewServiceDeps
  readonly override: Store<boolean>

  constructor(deps: ReviewServiceDeps) {
    this.#deps = deps
    this.override = deriveStore(
      deps.storage.session.store(REVIEW_OVERRIDE_STORAGE_KEY),
      selectIsOverride,
    )
  }

  readonly setOverride = (next: boolean): void => {
    this.#deps.storage.session.set(REVIEW_OVERRIDE_STORAGE_KEY, next ? 'true' : null)
  }

  shouldAsk(): boolean {
    const { storage, clock, platform, classicAccess, mobile, versions } = this.#deps
    if (mobile === null) {
      return false
    }
    return decideAskForReview({
      marked: versions.has(marketingVersion(platform.appVersion)),
      environment: mobile.appStoreEnvironment.get().value,
      paid: mobile.subscription.get().value !== null || classicAccess.get().active,
      requestedAt: parseRequestedAt(storage.local.get(REVIEW_REQUESTED_AT_STORAGE_KEY)),
      now: clock.now(),
      override: this.override.get(),
    })
  }

  readonly requestReview = (): void => {
    const { storage, clock, mobile } = this.#deps
    if (mobile === null) {
      return
    }
    // StoreKit never says whether the prompt showed, so every tap counts.
    storage.local.set(REVIEW_REQUESTED_AT_STORAGE_KEY, String(clock.now()))
    void this.#tryRequestReview(mobile.appStore)
  }

  readonly writeReview = (): void => {
    this.#deps.opener.openUrlSync(WRITE_REVIEW_URL)
  }

  readonly sendFeedback = (): void => {
    const { platform, opener } = this.#deps
    const subject = encodeURIComponent('Reflect feedback')
    const body = encodeURIComponent(
      `\n\n--\nReflect ${platform.appVersion} on ${platform.appPlatform}`,
    )
    opener.openUrlSync(`mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`)
  }

  async #tryRequestReview(appStore: MobileServices['appStore']): Promise<void> {
    try {
      await appStore.requestReview()
    } catch (cause: unknown) {
      this.#deps.logger.error('failed to request a review:', errorMessage(cause))
    }
  }
}

/**
 * The review request over the StoreKit services, local storage, and the opener.
 */
export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  return new ReviewServiceImpl(deps)
}
