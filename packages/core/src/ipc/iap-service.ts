import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from './ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin.ts'

/**
 * Typed bindings for `tauri-plugin-iap` — the StoreKit In-App Purchase
 * bridge (third-party, iOS-only in our build). Each schema mirrors the
 * plugin's wire format as of v0.9.1; check the permalinks below when
 * bumping the plugin version.
 * TS shapes (hand-written, no runtime guarantee):
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts
 * iOS ground truth (hand-built dictionaries; fields vary by code path):
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift
 * Rust request/response models (serde camelCase):
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/src/models.rs
 */

/**
 * The two auto-renewable subscription products (App Store Connect owns them).
 */
export const IAP_PRODUCT_IDS = {
  monthly: 'app.reflect.ios.pro.monthly',
  yearly: 'app.reflect.ios.pro.yearly',
} as const

// Product:
// https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L39
// https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/src/models.rs#L43
// https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L63
const iapProductSchema = z.object({
  productId: z.string(),
  formattedPrice: z.string().nullish(),
})

/**
 * One store product as the plugin reports it. `formattedPrice` is the
 * store-localized display price (e.g., "$4.99"); it is nullish on plugin code
 * paths that build the dictionary without loaded store metadata.
 */
export type IapProduct = z.infer<typeof iapProductSchema>

// Command args mirror the serde request models (`GetProductsRequest`,
// `PurchaseRequest`, ...) under the command's `payload` parameter.
const getProductsCommand = definePluginCommand<
  { payload: { productIds: string[]; productType: 'subs' } },
  { products: IapProduct[] }
>('iap', 'get_products', z.object({ products: z.array(iapProductSchema) }))

const purchaseCommand = definePluginCommand<
  { payload: { productId: string; productType: 'subs' } },
  unknown
>('iap', 'purchase', ignoredResult)

const getProductStatusCommand = definePluginCommand<
  { payload: { productId: string; productType: 'subs' } },
  { isOwned: boolean }
>('iap', 'get_product_status', z.object({ isOwned: z.boolean() }))

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
    const { products } = await getProductsCommand(this.#deps.ipc, {
      payload: { productIds, productType: 'subs' },
    })
    return products
  }

  async purchase(productId: string): Promise<void> {
    await purchaseCommand(this.#deps.ipc, { payload: { productId, productType: 'subs' } })
  }

  async isOwned(productId: string): Promise<boolean> {
    const { isOwned } = await getProductStatusCommand(this.#deps.ipc, {
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
