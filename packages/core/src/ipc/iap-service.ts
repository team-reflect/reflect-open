import type { IapProduct } from '@reflect/types'
import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from './ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { definePluginEvent } from './plugin.ts'

/**
 * The `plugin:iap` commands, the StoreKit In-App Purchase bridge
 * (`apple/Sources/AppStoreKit/StoreCommands.swift`). The wire format comes
 * from `tauri-plugin-iap` v0.9.1, which the permalinks below show.
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
 * the purchase sheet (`Transaction.updates`:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L350).
 * The payload is the full Purchase object, but subscribers only treat the
 * event as a refetch signal, so it stays unparsed.
 */
const purchaseUpdatedEvent = definePluginEvent('iap', 'purchaseUpdated', z.unknown())

/**
 * StoreKit subscriptions.
 */
export interface IapService {
  /**
   * The store's localized offers for `productIds` (get_products:
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L214
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L63).
   */
  getProducts(productIds: string[]): Promise<IapProduct[]>
  /**
   * Run the StoreKit purchase sheet for one product (purchase:
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L258
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L137).
   * The Purchase response
   * (https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/src/models.rs#L98)
   * is ignored; refetch entitlements after this resolves. Do not wait for
   * `purchaseUpdated` instead: the plugin never emits it for an in-app
   * purchase.
   */
  purchase(productId: string): Promise<void>
  /**
   * Whether the device currently owns `productId` (get_product_status:
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L393
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L280).
   * Only `productId` and `isOwned` are always present (ProductStatus:
   * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/src/models.rs#L200).
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
