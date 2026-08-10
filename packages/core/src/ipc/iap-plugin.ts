import { z } from 'zod'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin'

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

/** The two auto-renewable subscription products (App Store Connect owns them). */
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
 * store-localized display price ("$4.99"); it is nullish on plugin code
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

const restorePurchasesCommand = definePluginCommand<
  { payload: { productType: 'subs' } },
  { purchases: unknown[] }
>('iap', 'restore_purchases', z.object({ purchases: z.array(z.unknown()) }))

const getProductStatusCommand = definePluginCommand<
  { payload: { productId: string; productType: 'subs' } },
  { isOwned: boolean }
>('iap', 'get_product_status', z.object({ isOwned: z.boolean() }))

/**
 * The store's localized offers for `productIds` (get_products:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L214
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L63).
 */
export async function iapGetProducts(productIds: string[]): Promise<IapProduct[]> {
  const { products } = await getProductsCommand({ payload: { productIds, productType: 'subs' } })
  return products
}

/**
 * Run the StoreKit purchase sheet for one product (purchase:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L258
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L137).
 * The Purchase response
 * (https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/src/models.rs#L98)
 * is ignored; callers refetch entitlements after the command resolves. Do
 * not wait for purchaseUpdated instead: the plugin never emits it for an
 * in-app purchase (see subscribeIapPurchaseUpdated).
 */
export async function iapPurchase(productId: string): Promise<void> {
  await purchaseCommand({ payload: { productId, productType: 'subs' } })
}

/**
 * Re-sync entitlements from the App Store account, returning how many were
 * found (restore_purchases:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L285
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L192).
 */
export async function iapRestorePurchases(): Promise<number> {
  const { purchases } = await restorePurchasesCommand({ payload: { productType: 'subs' } })
  return purchases.length
}

/**
 * Whether the device currently owns `productId` (get_product_status:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/guest-js/index.ts#L393
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L280).
 * Only `productId` and `isOwned` are always present (ProductStatus:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/src/models.rs#L200).
 */
export async function iapIsOwned(productId: string): Promise<boolean> {
  const { isOwned } = await getProductStatusCommand({ payload: { productId, productType: 'subs' } })
  return isOwned
}

/**
 * Fires on purchases, renewals, and offer-code redemptions finished outside
 * the purchase sheet (`Transaction.updates`:
 * https://github.com/Choochmeque/tauri-plugin-iap/blob/v0.9.1/ios/Sources/IapPlugin.swift#L350).
 * The payload is the full Purchase object, but subscribers only treat the
 * event as a refetch signal, so it stays unparsed.
 */
export const subscribeIapPurchaseUpdated = definePluginEvent('iap', 'purchaseUpdated', z.unknown())
