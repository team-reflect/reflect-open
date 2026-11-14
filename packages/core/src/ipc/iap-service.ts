import type { IapProduct } from '@reflect/types'
import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from './ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { definePluginEvent } from './plugin.ts'

/**
 * The `plugin:iap` commands, the StoreKit In-App Purchase bridge
 * (`apple/Sources/AppStoreKit/StoreCommands.swift`). The command table
 * (`crates/types/src/commands.rs`) lists the commands, and
 * `crates/types/src/shell.rs` holds their wire types.
 */

/**
 * The two auto-renewable subscription products (App Store Connect owns them).
 */
export const IAP_PRODUCT_IDS = {
  monthly: 'app.reflect.ios.pro.monthly',
  yearly: 'app.reflect.ios.pro.yearly',
} as const

export type { IapProduct } from '@reflect/types'

/**
 * Fires on purchases, renewals, and offer-code redemptions finished outside
 * the purchase sheet (`Transaction.updates`). Subscribers treat the event
 * as a refetch signal, so the payload stays unparsed.
 */
const purchaseUpdatedEvent = definePluginEvent('iap', 'purchaseUpdated', z.unknown())

/**
 * StoreKit subscriptions.
 */
export interface IapService {
  /**
   * The store's localized offers for `productIds`.
   */
  getProducts(productIds: string[]): Promise<IapProduct[]>
  /**
   * Run the StoreKit purchase sheet for one product. Refetch entitlements
   * after this resolves. Do not wait for `purchaseUpdated` instead: the shell
   * never emits it for an in-app purchase.
   */
  purchase(productId: string): Promise<void>
  /**
   * Whether the device currently owns `productId`.
   */
  isOwned(productId: string): Promise<boolean>
  /**
   * Calls `listener` on every purchase, renewal, or offer-code redemption
   * finished outside the purchase sheet. A failed registration is logged.
   */
  subscribePurchaseUpdated(listener: () => void): Unlisten
}

export interface IapServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class IapServiceImpl implements IapService {
  readonly #deps: IapServiceDeps

  constructor(deps: IapServiceDeps) {
    this.#deps = deps
  }

  async getProducts(productIds: string[]): Promise<IapProduct[]> {
    const { products } = await this.#deps.ipc.call('plugin:iap|get_products', {
      payload: { productIds, productType: 'subs' },
    })
    return products
  }

  async purchase(productId: string): Promise<void> {
    await this.#deps.ipc.call('plugin:iap|purchase', {
      payload: { productId, productType: 'subs' },
    })
  }

  async isOwned(productId: string): Promise<boolean> {
    const { isOwned } = await this.#deps.ipc.call('plugin:iap|get_product_status', {
      payload: { productId, productType: 'subs' },
    })
    return isOwned
  }

  subscribePurchaseUpdated(listener: () => void): Unlisten {
    const { ipc, logger } = this.#deps
    const subscription = purchaseUpdatedEvent(ipc, () => {
      listener()
    })
    subscription.ready.catch((error: unknown) => {
      logger.error('subscribing to purchaseUpdated failed', error)
    })
    return subscription.unlisten
  }
}

export function createIapService(deps: IapServiceDeps): IapService {
  return new IapServiceImpl(deps)
}
