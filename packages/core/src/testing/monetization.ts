import type {
  ClassicAccess,
  ClassicAccessService,
  ClassicAccessState,
  ClassicSignInOptions,
  ClassicSignInResult,
} from '../classic/classic-access-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type {
  AppStoreEnvironment,
  AppStoreEnvironmentService,
  AppStoreEnvironmentState,
} from '../monetization/app-store-environment-service.ts'
import type {
  ActiveSubscription,
  SubscriptionService,
  SubscriptionState,
} from '../monetization/subscription-service.ts'

class Listeners {
  readonly #listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export type ClassicAccessCall = 'read' | 'load' | 'signIn' | 'signOut' | 'start'

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
  #current: ClassicAccessState
  #signIn: (options: ClassicSignInOptions) => Promise<ClassicSignInResult> = async () => ({
    kind: 'cancelled',
  })
  readonly #log: ClassicAccessCall[] = []
  readonly #signInLog: ClassicSignInOptions[] = []
  readonly #listeners = new Listeners()

  constructor(state?: Partial<ClassicAccessState>) {
    this.#current = { access: null, active: false, isLoading: false, ...state }
  }

  readonly getState = (): ClassicAccessState => this.#current

  readonly subscribe = this.#listeners.subscribe

  read(): ClassicAccess | null {
    this.#log.push('read')
    return this.#current.access
  }

  load(): ClassicAccess | null {
    this.#log.push('load')
    return this.#current.access
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

  start(): Unlisten {
    this.#log.push('start')
    return () => {}
  }

  setState(patch: Partial<ClassicAccessState>): void {
    this.#current = { ...this.#current, ...patch }
    this.#listeners.notify()
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
 * `signOut` clears the access; `start` only records the call.
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
  #current: SubscriptionState
  readonly #log: SubscriptionCall[] = []
  readonly #listeners = new Listeners()

  constructor(state?: Partial<SubscriptionState>) {
    this.#current = { value: null, isLoading: false, isError: false, ...state }
  }

  readonly getState = (): SubscriptionState => this.#current

  readonly subscribe = this.#listeners.subscribe

  activeSubscription(): Promise<ActiveSubscription> {
    this.#log.push('activeSubscription')
    return Promise.resolve(this.#current.value)
  }

  readonly refetch = (): Promise<ActiveSubscription> => {
    this.#log.push('refetch')
    return Promise.resolve(this.#current.value)
  }

  readonly invalidate = (): void => {
    this.#log.push('invalidate')
  }

  setState(patch: Partial<SubscriptionState>): void {
    this.#current = { ...this.#current, ...patch }
    this.#listeners.notify()
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
  #current: AppStoreEnvironmentState
  readonly #log: AppStoreEnvironmentCall[] = []
  readonly #listeners = new Listeners()

  constructor(env: AppStoreEnvironment) {
    this.#current = { value: env, isLoading: false, isError: false }
  }

  readonly getState = (): AppStoreEnvironmentState => this.#current

  readonly subscribe = this.#listeners.subscribe

  environment(): Promise<AppStoreEnvironment> {
    this.#log.push('environment')
    return Promise.resolve(this.#current.value)
  }

  readonly invalidate = (): void => {
    this.#log.push('invalidate')
  }

  setState(patch: Partial<AppStoreEnvironmentState>): void {
    this.#current = { ...this.#current, ...patch }
    this.#listeners.notify()
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
