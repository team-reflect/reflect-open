import {
  deriveStore,
  errorMessage,
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
 * When the review page last showed, in epoch milliseconds.
 */
export const REVIEW_SHOWN_AT_STORAGE_KEY = 'reflect.review.shown-at'

/**
 * Forces the review page on for QA, for this session only.
 */
export const REVIEW_OVERRIDE_STORAGE_KEY = 'reflect.review.override'

/**
 * How long the review page stays away after Rate Reflect, matching Apple's
 * prompt quota period.
 */
export const REVIEW_COOLDOWN_DAYS = 365

/**
 * How long the review page stays away after it showed without a rating.
 */
export const REVIEW_SHOWN_COOLDOWN_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export const WRITE_REVIEW_URL = 'https://apps.apple.com/app/id6787385615?action=write-review'

const FEEDBACK_EMAIL = 'support@reflect.app'

const DISCORD_URL = 'https://reflect.app/discord'

const NEW_GITHUB_ISSUE_URL = 'https://github.com/team-reflect/reflect-open/issues/new'

/**
 * Where feedback goes: the Discord server, a GitHub issue, or an email to support.
 */
export type FeedbackChannel = 'discord' | 'github' | 'email'

/**
 * Everything {@link decideAskForReview} reads.
 */
export interface ReviewInputs {
  readonly environment: AppStoreEnvironment
  /**
   * The user has an App Store subscription or Reflect Classic access.
   */
  readonly paid: boolean
  readonly requestedAt: number | null
  readonly shownAt: number | null
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
  const since = (time: number | null, days: number): boolean => {
    return time === null || inputs.now - time >= days * DAY_MS
  }
  return (
    inputs.environment === 'Production' &&
    inputs.paid &&
    since(inputs.requestedAt, REVIEW_COOLDOWN_DAYS) &&
    since(inputs.shownAt, REVIEW_SHOWN_COOLDOWN_DAYS)
  )
}

function selectIsOverride(value: string | null): boolean {
  return value === 'true'
}

function parseTime(value: string | null): number | null {
  if (value === null) {
    return null
  }
  const time = Number(value)
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
   * Whether the review page should follow What's New right now. Waits for
   * this launch's App Store environment.
   */
  shouldAsk(): Promise<boolean>
  /**
   * Records that the review page showed, which keeps it away for 30 days.
   */
  markShown: () => void
  /**
   * Asks StoreKit for its review prompt, and starts the cooldown once the
   * request reaches it.
   */
  requestReview: () => void
  /**
   * Opens the App Store page that writes a review.
   */
  writeReview: () => void
  /**
   * Opens the given feedback channel.
   */
  sendFeedback: (channel: FeedbackChannel) => void
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

  async shouldAsk(): Promise<boolean> {
    const { storage, clock, platform, classicAccess, mobile } = this.#deps
    if (mobile === null || platform.appPlatform !== 'ios') {
      return false
    }
    return decideAskForReview({
      environment: await mobile.appStoreEnvironment.environment(),
      paid: mobile.subscription.get().value !== null || classicAccess.get().active,
      requestedAt: parseTime(storage.local.get(REVIEW_REQUESTED_AT_STORAGE_KEY)),
      shownAt: parseTime(storage.local.get(REVIEW_SHOWN_AT_STORAGE_KEY)),
      now: clock.now(),
      override: this.override.get(),
    })
  }

  readonly markShown = (): void => {
    const { storage, clock } = this.#deps
    storage.local.set(REVIEW_SHOWN_AT_STORAGE_KEY, String(clock.now()))
  }

  readonly requestReview = (): void => {
    const { mobile } = this.#deps
    if (mobile === null) {
      return
    }
    void this.#tryRequestReview(mobile.appStore)
  }

  readonly writeReview = (): void => {
    this.#deps.opener.openUrlSync(WRITE_REVIEW_URL)
  }

  readonly sendFeedback = (channel: FeedbackChannel): void => {
    this.#deps.opener.openUrlSync(this.#feedbackUrl(channel))
  }

  #feedbackUrl(channel: FeedbackChannel): string {
    if (channel === 'discord') {
      return DISCORD_URL
    }
    if (channel === 'github') {
      return NEW_GITHUB_ISSUE_URL
    }
    const { platform } = this.#deps
    const subject = encodeURIComponent('Reflect feedback')
    const body = encodeURIComponent(
      `\n\n--\nReflect ${platform.appVersion} on ${platform.appPlatform}`,
    )
    return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`
  }

  async #tryRequestReview(appStore: MobileServices['appStore']): Promise<void> {
    try {
      await appStore.requestReview()
      // StoreKit never says whether the prompt showed, so every call that
      // reached it counts.
      const { storage, clock } = this.#deps
      storage.local.set(REVIEW_REQUESTED_AT_STORAGE_KEY, String(clock.now()))
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
