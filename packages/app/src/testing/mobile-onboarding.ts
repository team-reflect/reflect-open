import type { MobileStorageKind, Unlisten } from '@reflect/core'
import {
  createTestActivityPort,
  createTestClockService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestMobileStorageService,
  createTestPlatformService,
  createTestSettingsService,
} from '@reflect/core/testing'
import {
  createMobileOnboardingService,
  type MobileOnboardingService,
  type MobileOnboardingServiceDeps,
  type MobileOnboardingState,
} from '../graph/mobile-onboarding-service.ts'

/**

 * The services a test mobile onboarding runs on; each defaults to a fresh test double.

 */
export interface TestMobileOnboardingServiceOptions extends Partial<MobileOnboardingServiceDeps> {
  /**
   * Reported over the real state from the start, as {@link TestMobileOnboardingService.setState} does.
   */
  state?: Partial<MobileOnboardingState>
}

export interface TestMobileOnboardingService extends MobileOnboardingService {
  /**
   * Report `patch` over the real state and notify subscribers.
   */
  setState(patch: Partial<MobileOnboardingState>): void
}

class TestMobileOnboardingServiceImpl implements TestMobileOnboardingService {
  readonly #inner: MobileOnboardingService
  readonly #listeners = new Set<() => void>()
  #overlay: Partial<MobileOnboardingState>
  #merged: { base: MobileOnboardingState; overlay: Partial<MobileOnboardingState> } | null = null
  #snapshot: MobileOnboardingState

  constructor(inner: MobileOnboardingService, state: Partial<MobileOnboardingState> | undefined) {
    this.#inner = inner
    this.#overlay = state ?? {}
    this.#snapshot = inner.getState()
  }

  readonly getState = (): MobileOnboardingState => {
    const base = this.#inner.getState()
    if (this.#merged?.base !== base || this.#merged.overlay !== this.#overlay) {
      this.#merged = { base, overlay: this.#overlay }
      this.#snapshot = { ...base, ...this.#overlay }
    }
    return this.#snapshot
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    const unlisten = this.#inner.subscribe(listener)
    this.#listeners.add(listener)
    return () => {
      unlisten()
      this.#listeners.delete(listener)
    }
  }

  warm(): void {
    this.#inner.warm()
  }

  boot(): Unlisten {
    return this.#inner.boot()
  }

  completeOnboarding(kind: MobileStorageKind, root?: string): Promise<void> {
    return this.#inner.completeOnboarding(kind, root)
  }

  setState(patch: Partial<MobileOnboardingState>): void {
    this.#overlay = { ...this.#overlay, ...patch }
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/**
 * The real {@link MobileOnboardingService} over test doubles, plus state seeding.
 */
export function createTestMobileOnboardingService(
  options?: TestMobileOnboardingServiceOptions,
): TestMobileOnboardingService {
  return new TestMobileOnboardingServiceImpl(
    createMobileOnboardingService({
      mobileStorage: options?.mobileStorage ?? createTestMobileStorageService(),
      settings: options?.settings ?? createTestSettingsService(),
      graphSession: options?.graphSession ?? createTestGraphSessionService(),
      platform: options?.platform ?? createTestPlatformService(),
      clock: options?.clock ?? createTestClockService(),
      activity: options?.activity ?? createTestActivityPort(),
      logger: options?.logger ?? createTestLoggerService(),
    }),
    options?.state,
  )
}
