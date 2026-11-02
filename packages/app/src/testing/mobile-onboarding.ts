import {
  combineStores,
  WritableStore,
  type MobileStorageKind,
  type Store,
  type Unlisten,
} from '@reflect/core'
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
  readonly #overlay: WritableStore<Partial<MobileOnboardingState>>
  readonly #state: Store<MobileOnboardingState>

  constructor(inner: MobileOnboardingService, state: Partial<MobileOnboardingState> | undefined) {
    this.#inner = inner
    this.#overlay = new WritableStore(state ?? {})
    this.#state = combineStores([inner, this.#overlay], (base, overlay) => ({
      ...base,
      ...overlay,
    }))
  }

  readonly get = (): MobileOnboardingState => this.#state.get()

  readonly subscribe = (listener: VoidFunction): Unlisten => this.#state.subscribe(listener)

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
    this.#overlay.set({ ...this.#overlay.get(), ...patch })
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
