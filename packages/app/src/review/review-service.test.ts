import { describe, expect, it, vi } from 'vitest'
import {
  createTestAppStoreEnvironmentService,
  createTestAppStoreService,
  createTestClassicAccessService,
  createTestClockService,
  createTestLoggerService,
  createTestPlatformService,
  createTestStorageService,
  createTestSubscriptionService,
} from '@reflect/core/testing'
import { createTestOpenerService } from '../testing/opener.ts'
import {
  createReviewService,
  decideAskForReview,
  REVIEW_COOLDOWN_DAYS,
  REVIEW_REQUESTED_AT_STORAGE_KEY,
  REVIEW_SHOWN_AT_STORAGE_KEY,
  REVIEW_SHOWN_COOLDOWN_DAYS,
  WRITE_REVIEW_URL,
  type ReviewInputs,
} from './review-service.ts'

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

const INPUTS: ReviewInputs = {
  environment: 'Production',
  paid: true,
  requestedAt: null,
  shownAt: null,
  now: NOW,
  override: false,
}

function decide(inputs: Partial<ReviewInputs>) {
  return decideAskForReview({ ...INPUTS, ...inputs })
}

describe('decideAskForReview', () => {
  it('asks a paying App Store user', () => {
    expect(decide({})).toBe(true)
  })

  it('does not ask when any condition fails', () => {
    const cases: Partial<ReviewInputs>[] = [
      { environment: 'Sandbox' },
      { environment: 'Xcode' },
      { environment: null },
      { paid: false },
      { requestedAt: NOW - REVIEW_COOLDOWN_DAYS * DAY_MS + 1 },
      { shownAt: NOW - REVIEW_SHOWN_COOLDOWN_DAYS * DAY_MS + 1 },
    ]
    for (const inputs of cases) {
      expect(decide(inputs)).toBe(false)
    }
  })

  it('asks again once each cooldown ends', () => {
    expect(decide({ requestedAt: NOW - REVIEW_COOLDOWN_DAYS * DAY_MS })).toBe(true)
    expect(decide({ shownAt: NOW - REVIEW_SHOWN_COOLDOWN_DAYS * DAY_MS })).toBe(true)
  })

  it('asks with the override despite every condition', () => {
    expect(
      decide({
        override: true,
        environment: 'Sandbox',
        paid: false,
        requestedAt: NOW,
        shownAt: NOW,
      }),
    ).toBe(true)
  })
})

function setup(options: { mobile?: boolean; appPlatform?: 'ios' | 'android' } = {}) {
  const storage = createTestStorageService()
  const appStore = createTestAppStoreService()
  const opener = createTestOpenerService()
  const review = createReviewService({
    storage,
    clock: createTestClockService({ now: NOW }),
    platform: createTestPlatformService({
      appPlatform: options.appPlatform ?? 'ios',
      appVersion: '0.20.0',
    }),
    logger: createTestLoggerService(),
    opener,
    classicAccess: createTestClassicAccessService(),
    mobile:
      options.mobile === false
        ? null
        : {
            appStore,
            appStoreEnvironment: createTestAppStoreEnvironmentService('Production'),
            subscription: createTestSubscriptionService({ value: 'monthly' }),
          },
  })
  return { review, storage, appStore, opener }
}

describe('createReviewService', () => {
  it('asks, then stays away once the page shows', async () => {
    const { review, storage } = setup()
    expect(await review.shouldAsk()).toBe(true)
    review.markShown()
    expect(storage.local.get(REVIEW_SHOWN_AT_STORAGE_KEY)).toBe(String(NOW))
    expect(await review.shouldAsk()).toBe(false)
  })

  it('requests the prompt and starts the cooldown', async () => {
    const { review, storage, appStore } = setup()
    review.requestReview()
    expect(appStore.calls()).toEqual(['requestReview'])
    await vi.waitFor(() => {
      expect(storage.local.get(REVIEW_REQUESTED_AT_STORAGE_KEY)).toBe(String(NOW))
    })
    expect(await review.shouldAsk()).toBe(false)
  })

  it('never asks outside iOS, even with the override', async () => {
    const android = setup({ appPlatform: 'android' }).review
    android.setOverride(true)
    expect(await android.shouldAsk()).toBe(false)

    const { review, storage } = setup({ mobile: false })
    review.setOverride(true)
    expect(await review.shouldAsk()).toBe(false)
    review.requestReview()
    expect(storage.local.get(REVIEW_REQUESTED_AT_STORAGE_KEY)).toBeNull()
  })

  it('opens the write-review page and each feedback channel', () => {
    const { review, opener } = setup()
    review.writeReview()
    review.sendFeedback('email')
    review.sendFeedback('discord')
    review.sendFeedback('github')
    expect(opener.openedUrls()).toEqual([
      WRITE_REVIEW_URL,
      'mailto:support@reflect.app?subject=Reflect%20feedback&body=%0A%0A--%0AReflect%200.20.0%20on%20ios',
      'https://reflect.app/discord',
      'https://github.com/team-reflect/reflect-open/issues/new',
    ])
  })
})
