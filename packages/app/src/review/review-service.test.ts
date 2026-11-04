import { describe, expect, it } from 'vitest'
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
  REVIEW_COOLDOWN_MS,
  REVIEW_REQUESTED_AT_STORAGE_KEY,
  WRITE_REVIEW_URL,
  type ReviewInputs,
} from './review-service.ts'

const NOW = 1_800_000_000_000

const INPUTS: ReviewInputs = {
  marked: true,
  environment: 'Production',
  paid: true,
  requestedAt: null,
  now: NOW,
  override: false,
}

function decide(inputs: Partial<ReviewInputs>) {
  return decideAskForReview({ ...INPUTS, ...inputs })
}

describe('decideAskForReview', () => {
  it('asks a paying App Store user on a marked version', () => {
    expect(decide({})).toBe(true)
  })

  it('does not ask when any condition fails', () => {
    const cases: Partial<ReviewInputs>[] = [
      { marked: false },
      { environment: 'Sandbox' },
      { environment: 'Xcode' },
      { environment: null },
      { paid: false },
      { requestedAt: NOW - REVIEW_COOLDOWN_MS + 1 },
    ]
    for (const inputs of cases) {
      expect(decide(inputs)).toBe(false)
    }
  })

  it('asks again once the cooldown ends', () => {
    expect(decide({ requestedAt: NOW - REVIEW_COOLDOWN_MS })).toBe(true)
  })

  it('asks with the override despite every condition', () => {
    expect(
      decide({
        override: true,
        marked: false,
        environment: 'Sandbox',
        paid: false,
        requestedAt: NOW,
      }),
    ).toBe(true)
  })
})

function setup(options: { version?: string; mobile?: boolean } = {}) {
  const storage = createTestStorageService()
  const appStore = createTestAppStoreService()
  const opener = createTestOpenerService()
  const review = createReviewService({
    storage,
    clock: createTestClockService({ now: NOW }),
    platform: createTestPlatformService({
      appPlatform: 'ios',
      appVersion: options.version ?? '0.20.0',
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
    versions: new Set(['0.20.0']),
  })
  return { review, storage, appStore, opener }
}

describe('createReviewService', () => {
  it('matches a beta to its marketing version', () => {
    expect(setup({ version: '0.20.0-beta.2' }).review.shouldAsk()).toBe(true)
    expect(setup({ version: '0.21.0' }).review.shouldAsk()).toBe(false)
  })

  it('requests the prompt and starts the cooldown', () => {
    const { review, storage, appStore } = setup()
    review.requestReview()
    expect(appStore.calls()).toEqual(['requestReview'])
    expect(storage.local.get(REVIEW_REQUESTED_AT_STORAGE_KEY)).toBe(String(NOW))
    expect(review.shouldAsk()).toBe(false)
  })

  it('never asks without the StoreKit services, even with the override', () => {
    const { review, storage } = setup({ mobile: false })
    review.setOverride(true)
    expect(review.shouldAsk()).toBe(false)
    review.requestReview()
    expect(storage.local.get(REVIEW_REQUESTED_AT_STORAGE_KEY)).toBeNull()
  })

  it('opens the write-review page and a feedback email', () => {
    const { review, opener } = setup()
    review.writeReview()
    review.sendFeedback()
    expect(opener.openedUrls()).toEqual([
      WRITE_REVIEW_URL,
      'mailto:support@reflect.app?subject=Reflect%20feedback&body=%0A%0A--%0AReflect%200.20.0%20on%20ios',
    ])
  })
})
