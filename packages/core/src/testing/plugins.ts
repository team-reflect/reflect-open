import { AppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type { AppStoreService } from '../ipc/app-store-service.ts'
import type { IapProduct, IapService } from '../ipc/iap-service.ts'
import type { HapticsService } from '../ipc/haptics-service.ts'
import type { WebAuthOptions, WebAuthService } from '../ipc/web-auth-service.ts'

export interface TestHapticsService extends HapticsService {
  /**
   * The number of `impactLight` calls since creation or the last `reset`.
   */
  impacts(): number
  reset(): void
}

class TestHapticsServiceImpl implements TestHapticsService {
  readonly #fail: boolean
  #count = 0

  constructor(options?: { fail?: boolean }) {
    this.#fail = options?.fail ?? false
  }

  impactLight(): Promise<void> {
    this.#count += 1
    if (this.#fail) {
      return Promise.reject(new AppError('io', 'test haptics: no haptic engine'))
    }
    return Promise.resolve()
  }

  impacts(): number {
    return this.#count
  }

  reset(): void {
    this.#count = 0
  }
}

/**
 * A {@link HapticsService} that counts impacts. With `fail`, every call is
 * still counted but rejects, like an engine that is not there.
 */
export function createTestHapticsService(options?: { fail?: boolean }): TestHapticsService {
  return new TestHapticsServiceImpl(options)
}

export interface TestIapService extends IapService {
  /**
   * Calls every `subscribePurchaseUpdated` listener.
   */
  emitPurchaseUpdated(): void
  /**
   * Every `purchase` product id, in order.
   */
  purchases(): readonly string[]
}

class TestIapServiceImpl implements TestIapService {
  readonly #products: readonly IapProduct[]
  readonly #owned: Set<string>
  readonly #purchased: string[] = []
  readonly #listeners = new Set<() => void>()

  constructor(options?: { products?: readonly IapProduct[]; owned?: readonly string[] }) {
    this.#products = options?.products ?? []
    this.#owned = new Set(options?.owned ?? [])
  }

  getProducts(productIds: string[]): Promise<IapProduct[]> {
    return Promise.resolve(
      this.#products
        .filter((product) => productIds.includes(product.productId))
        .map((product) => ({ ...product })),
    )
  }

  purchase(productId: string): Promise<void> {
    this.#purchased.push(productId)
    this.#owned.add(productId)
    return Promise.resolve()
  }

  isOwned(productId: string): Promise<boolean> {
    return Promise.resolve(this.#owned.has(productId))
  }

  subscribePurchaseUpdated(listener: () => void): Unlisten {
    const entry = (): void => {
      listener()
    }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  emitPurchaseUpdated(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  purchases(): readonly string[] {
    return [...this.#purchased]
  }
}

/**
 * An in-memory {@link IapService}. `getProducts` answers the known products
 * among the requested ids; `purchase` makes a product owned.
 */
export function createTestIapService(options?: {
  products?: readonly IapProduct[]
  owned?: readonly string[]
}): TestIapService {
  return new TestIapServiceImpl(options)
}

export type AppStoreCall = 'environment' | 'sync' | 'presentOfferCodeRedeemSheet'

export interface TestAppStoreService extends AppStoreService {
  /**
   * Every call, in order.
   */
  calls(): readonly AppStoreCall[]
}

class TestAppStoreServiceImpl implements TestAppStoreService {
  readonly #environment: string
  readonly #log: AppStoreCall[] = []

  constructor(options?: { environment?: string }) {
    this.#environment = options?.environment ?? 'Production'
  }

  environment(): string {
    this.#log.push('environment')
    return this.#environment
  }

  sync(): void {
    this.#log.push('sync')
    return
  }

  presentOfferCodeRedeemSheet(): void {
    this.#log.push('presentOfferCodeRedeemSheet')
    return
  }

  calls(): readonly AppStoreCall[] {
    return [...this.#log]
  }
}

/**
 * An in-memory {@link AppStoreService}; `environment` defaults to `'Production'`.
 */
export function createTestAppStoreService(options?: { environment?: string }): TestAppStoreService {
  return new TestAppStoreServiceImpl(options)
}

export interface TestWebAuthService extends WebAuthService {
  /**
   * The options of every `start`, in order.
   */
  starts(): readonly WebAuthOptions[]
  setCallbackUrl(callbackUrl: string | null): void
}

class TestWebAuthServiceImpl implements TestWebAuthService {
  #callback: string | null
  readonly #log: WebAuthOptions[] = []

  constructor(callbackUrl: string | null) {
    this.#callback = callbackUrl
  }

  start(options: WebAuthOptions): Promise<string | null> {
    this.#log.push({ ...options })
    return Promise.resolve(this.#callback)
  }

  starts(): readonly WebAuthOptions[] {
    return [...this.#log]
  }

  setCallbackUrl(next: string | null): void {
    this.#callback = next
  }
}

/**
 * A {@link WebAuthService} whose sessions end at `callbackUrl`; `null` is a cancel.
 */
export function createTestWebAuthService(callbackUrl: string | null): TestWebAuthService {
  return new TestWebAuthServiceImpl(callbackUrl)
}
