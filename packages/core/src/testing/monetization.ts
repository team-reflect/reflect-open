import { isDeepEqual } from '@ocavue/utils'
import type {
  ClassicAccess,
  ClassicAccessService,
  ClassicAccessState,
  ClassicSignInOptions,
  ClassicSignInResult,
} from '../classic/classic-access-service.ts'
import { WritableStore } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type {
  AppStoreEnvironment,
  AppStoreEnvironmentService,
  AppStoreEnvironmentState,
} from '../monetization/app-store-environment-service.ts'
import type {
  InstallClockService,
  InstallClockState,
} from '../monetization/install-clock-service.ts'
import type {
  ActiveSubscription,
  SubscriptionService,
  SubscriptionState,
} from '../monetization/subscription-service.ts'

export type ClassicAccessCall = 'read' | 'load' | 'signIn' | 'signOut'

export interface TestClassicAccessService extends ClassicAccessService {
  /**
   * Replaces part of the state and notifies subscribers.
   */
  setState(patch: Partial<ClassicAccessState>): void
  /**
   * Answers every later `signIn`.
   */
  setSignIn(handler: (options: ClassicSignInOptions) => Promise<ClassicSignInResult>): void
  /**
   * Every call, in order.
   */
  calls(): readonly ClassicAccessCall[]
  /**
   * The options of every `signIn`, in order.
   */
  signIns(): readonly ClassicSignInOptions[]
}

class TestClassicAccessServiceImpl implements TestClassicAccessService {
  readonly #state: WritableStore<ClassicAccessState>
  #signIn: (options: ClassicSignInOptions) => Promise<ClassicSignInResult> = () => {
    return Promise.resolve({
      kind: 'cancelled',
    })
  }
  readonly #log: ClassicAccessCall[] = []
  readonly #signInLog: ClassicSignInOptions[] = []
  readonly get: () => ClassicAccessState
  readonly subscribe: (listener: VoidFunction) => Unlisten

  constructor(state?: Partial<ClassicAccessState>) {
    this.#state = new WritableStore<ClassicAccessState>({
      access: null,
      active: false,
      isLoading: false,
      ...state,
    })
    this.get = this.#state.get
    this.subscribe = this.#state.subscribe
  }

  read(): ClassicAccess | null {
    this.#log.push('read')
    return this.get().access
  }

  load(): ClassicAccess | null {
    this.#log.push('load')
    return this.get().access
  }

  async signIn(options: ClassicSignInOptions): Promise<ClassicSignInResult> {
    this.#log.push('signIn')
    this.#signInLog.push(options)
    return await this.#signIn(options)
  }

  signOut(): void {
    this.#log.push('signOut')
    this.setState({ access: null, active: false })
    return
  }

  setState(patch: Partial<ClassicAccessState>): void {
    this.#state.set({ ...this.get(), ...patch })
  }

  setSignIn(handler: (options: ClassicSignInOptions) => Promise<ClassicSignInResult>): void {
    this.#signIn = handler
  }

  calls(): readonly ClassicAccessCall[] {
    return [...this.#log]
  }

  signIns(): readonly ClassicSignInOptions[] {
    return [...this.#signInLog]
  }
}

/**
 * A {@link ClassicAccessService} over a settable state. `read` and `load`
 * resolve the stored access; `signIn` resolves `cancelled` until `setSignIn`;
 * `signOut` clears the access.
 */
export function createTestClassicAccessService(
  state?: Partial<ClassicAccessState>,
): TestClassicAccessService {
  return new TestClassicAccessServiceImpl(state)
}

export type SubscriptionCall = 'activeSubscription' | 'refetch' | 'invalidate'

export interface TestSubscriptionService extends SubscriptionService {
  /**
   * Replaces part of the state and notifies subscribers.
   */
  setState(patch: Partial<SubscriptionState>): void
  /**
   * Every call, in order.
   */
  calls(): readonly SubscriptionCall[]
}

class TestSubscriptionServiceImpl implements TestSubscriptionService {
  readonly #state: WritableStore<SubscriptionState>
  readonly #log: SubscriptionCall[] = []
  readonly get: () => SubscriptionState
  readonly subscribe: (listener: VoidFunction) => Unlisten

  constructor(state?: Partial<SubscriptionState>) {
    this.#state = new WritableStore<SubscriptionState>(
      { value: null, isLoading: false, isError: false, ...state },
      isDeepEqual,
    )
    this.get = this.#state.get
    this.subscribe = this.#state.subscribe
  }

  activeSubscription(): Promise<ActiveSubscription> {
    this.#log.push('activeSubscription')
    return Promise.resolve(this.get().value)
  }

  readonly refetch = (): Promise<ActiveSubscription> => {
    this.#log.push('refetch')
    return Promise.resolve(this.get().value)
  }

  readonly invalidate = (): void => {
    this.#log.push('invalidate')
  }

  setState(patch: Partial<SubscriptionState>): void {
    this.#state.set({ ...this.get(), ...patch })
  }

  calls(): readonly SubscriptionCall[] {
    return [...this.#log]
  }
}

/**
 * A {@link SubscriptionService} over a settable state; lookups resolve the current value.
 */
export function createTestSubscriptionService(
  state?: Partial<SubscriptionState>,
): TestSubscriptionService {
  return new TestSubscriptionServiceImpl(state)
}

export type AppStoreEnvironmentCall = 'environment' | 'invalidate'

export interface TestAppStoreEnvironmentService extends AppStoreEnvironmentService {
  /**
   * Replaces part of the state and notifies subscribers.
   */
  setState(patch: Partial<AppStoreEnvironmentState>): void
  /**
   * Every call, in order.
   */
  calls(): readonly AppStoreEnvironmentCall[]
}

class TestAppStoreEnvironmentServiceImpl implements TestAppStoreEnvironmentService {
  readonly #state: WritableStore<AppStoreEnvironmentState>
  readonly #log: AppStoreEnvironmentCall[] = []
  readonly get: () => AppStoreEnvironmentState
  readonly subscribe: (listener: VoidFunction) => Unlisten

  constructor(env: AppStoreEnvironment) {
    this.#state = new WritableStore<AppStoreEnvironmentState>(
      {
        value: env,
        isLoading: false,
        isError: false,
      },
      isDeepEqual,
    )
    this.get = this.#state.get
    this.subscribe = this.#state.subscribe
  }

  environment(): Promise<AppStoreEnvironment> {
    this.#log.push('environment')
    return Promise.resolve(this.get().value)
  }

  readonly invalidate = (): void => {
    this.#log.push('invalidate')
  }

  setState(patch: Partial<AppStoreEnvironmentState>): void {
    this.#state.set({ ...this.get(), ...patch })
  }

  calls(): readonly AppStoreEnvironmentCall[] {
    return [...this.#log]
  }
}

/**
 * An {@link AppStoreEnvironmentService} that answers `env`; defaults to `Production`.
 */
export function createTestAppStoreEnvironmentService(
  env: AppStoreEnvironment = 'Production',
): TestAppStoreEnvironmentService {
  return new TestAppStoreEnvironmentServiceImpl(env)
}

/**
 * A settable {@link InstallClockService}.
 */
export interface TestInstallClockService extends InstallClockService {
  /**
   * Replaces part of the state and notifies subscribers.
   */
  setState(patch: Partial<InstallClockState>): void
}

class TestInstallClockServiceImpl implements TestInstallClockService {
  readonly #state: WritableStore<InstallClockState>
  readonly get: () => InstallClockState
  readonly subscribe: (listener: VoidFunction) => Unlisten

  constructor(state?: Partial<InstallClockState>) {
    this.#state = new WritableStore<InstallClockState>(
      { phase: 'hidden', firstLaunchAt: null, dayIndex: 0, isLoading: false, ...state },
      isDeepEqual,
    )
    this.get = this.#state.get
    this.subscribe = this.#state.subscribe
  }

  setState(patch: Partial<InstallClockState>): void {
    this.#state.set({ ...this.get(), ...patch })
  }
}

/**
 * An {@link InstallClockService} over a settable state, `hidden` by default.
 */
export function createTestInstallClockService(
  state?: Partial<InstallClockState>,
): TestInstallClockService {
  return new TestInstallClockServiceImpl(state)
}
