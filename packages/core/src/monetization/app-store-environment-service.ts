import { isDeepEqual } from '@ocavue/utils'
import { z } from 'zod'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { getJson, setJson, type StorageService } from '../ports/storage-service.ts'
import type { AppStoreService } from '../ipc/app-store-service.ts'
import { WritableStore, type Store } from '../store.ts'

const appStoreEnvironmentSchema = z.enum(['Production', 'Sandbox', 'Xcode']).nullable()

/**
 * The channel that installed this build, or `null` when unknown or unrecognized.
 */
export type AppStoreEnvironment = z.infer<typeof appStoreEnvironmentSchema>

/**
 * The channels worth remembering across launches. A remembered `Production`
 * reads exactly like no seed at all, so storing it can only let one launch's
 * answer outlive that launch.
 */
const rememberedEnvironmentSchema = z.enum(['Sandbox', 'Xcode'])

export const APP_STORE_ENVIRONMENT_STORAGE_KEY = 'reflect.app-store.environment'

export interface AppStoreEnvironmentState {
  /**
   * This launch's answer, else the remembered `Sandbox` or `Xcode`, else `null`.
   */
  readonly value: AppStoreEnvironment
  /**
   * True while nothing is known and this launch has no settled answer yet.
   */
  readonly isLoading: boolean
  /**
   * True when this launch's last probe failed.
   */
  readonly isError: boolean
}

/**
 * The App Store install channel, probed once per launch.
 */
export interface AppStoreEnvironmentService extends Store<AppStoreEnvironmentState> {
  /**
   * This launch's channel, probed unless this launch already answered. A
   * failed probe keeps the remembered channel and shows in `get().isError`.
   */
  environment(): Promise<AppStoreEnvironment>
  /**
   * Forgets this launch's answer, and probes again while anyone is subscribed.
   */
  invalidate: () => void
}

const IDLE_STATE: AppStoreEnvironmentState = { value: null, isLoading: false, isError: false }

export interface AppStoreEnvironmentServiceDeps {
  readonly appStore: AppStoreService
  readonly storage: StorageService
  readonly platform: PlatformFacts
}

class AppStoreEnvironmentServiceImpl implements AppStoreEnvironmentService {
  readonly #deps: AppStoreEnvironmentServiceDeps
  readonly #enabled: boolean
  readonly #state = new WritableStore<AppStoreEnvironmentState>(IDLE_STATE, isDeepEqual)
  #value: AppStoreEnvironment = null
  #answered = false
  #settled = false
  #probing = false
  #failed = false
  #pendingProbe: Promise<AppStoreEnvironment> | null = null

  constructor(deps: AppStoreEnvironmentServiceDeps) {
    this.#deps = deps
    this.#enabled = deps.platform.appPlatform === 'ios'
    if (this.#enabled) {
      this.#value =
        getJson(
          deps.storage.local,
          APP_STORE_ENVIRONMENT_STORAGE_KEY,
          rememberedEnvironmentSchema,
        ) ?? null
      this.#state.set(this.#computeState())
    }
  }

  readonly get = this.#state.get

  readonly subscribe = this.#state.subscribe

  environment(): Promise<AppStoreEnvironment> {
    if (!this.#enabled) {
      return Promise.resolve(null)
    }
    if (this.#answered) {
      return Promise.resolve(this.#value)
    }
    if (this.#pendingProbe === null) {
      const current = this.#probe()
      this.#pendingProbe = current
      void current.finally(() => {
        if (this.#pendingProbe === current) this.#pendingProbe = null
      })
    }
    return this.#pendingProbe
  }

  readonly invalidate = (): void => {
    this.#answered = false
    if (this.#state.subscribed()) {
      void this.environment()
    }
  }

  #computeState(): AppStoreEnvironmentState {
    return {
      value: this.#value,
      isLoading: this.#value === null && (this.#probing || !this.#settled),
      isError: this.#failed,
    }
  }

  #remember(environment: AppStoreEnvironment): void {
    const { storage } = this.#deps
    const remembered = rememberedEnvironmentSchema.safeParse(environment)
    if (remembered.success) {
      setJson(
        storage.local,
        APP_STORE_ENVIRONMENT_STORAGE_KEY,
        rememberedEnvironmentSchema,
        remembered.data,
      )
    } else {
      storage.local.set(APP_STORE_ENVIRONMENT_STORAGE_KEY, null)
    }
  }

  async #probe(): Promise<AppStoreEnvironment> {
    this.#probing = true
    this.#state.set(this.#computeState())
    try {
      let raw: string
      try {
        raw = await this.#deps.appStore.environment()
      } catch {
        raw = await this.#deps.appStore.environment()
      }
      const parsed = appStoreEnvironmentSchema.safeParse(raw)
      this.#value = parsed.success ? parsed.data : null
      this.#answered = true
      this.#failed = false
      this.#remember(this.#value)
    } catch {
      this.#failed = true
    } finally {
      this.#probing = false
      this.#settled = true
      this.#state.set(this.#computeState())
    }
    return this.#value
  }
}

export function createAppStoreEnvironmentService(
  deps: AppStoreEnvironmentServiceDeps,
): AppStoreEnvironmentService {
  return new AppStoreEnvironmentServiceImpl(deps)
}
