import { z } from 'zod'
import { call } from '../ipc/invoke'

// Wire-format references for tauri-plugin-iap v0.9.1 (commit 187f530), for
// future version bumps. The `#L` anchors on the schemas below point into
// these files.
// TS shapes (hand-written, no runtime guarantee):
// https://github.com/Choochmeque/tauri-plugin-iap/blob/187f530f163814787584bab441ef8e1b92e234d0/guest-js/index.ts
// iOS ground truth (hand-built dictionaries; fields vary by code path):
// https://github.com/Choochmeque/tauri-plugin-iap/blob/187f530f163814787584bab441ef8e1b92e234d0/ios/Sources/IapPlugin.swift
// Rust request/response models (serde camelCase):
// https://github.com/Choochmeque/tauri-plugin-iap/blob/187f530f163814787584bab441ef8e1b92e234d0/src/models.rs

/** The two auto-renewable subscription products (App Store Connect owns them). */
export const IAP_PRODUCT_IDS = {
  monthly: 'app.reflect.ios.pro.monthly',
  yearly: 'app.reflect.ios.pro.yearly',
} as const

// Product: guest-js/index.ts#L39, models.rs#L43, IapPlugin.swift#L63.
const iapProductSchema = z.object({
  productId: z.string(),
  formattedPrice: z.string().nullish(),
})

export type IapProduct = z.infer<typeof iapProductSchema>

// get_products: guest-js/index.ts#L214, IapPlugin.swift#L63.
export async function iapGetProducts(productIds: string[]): Promise<IapProduct[]> {
  const response = await call(
    'plugin:iap|get_products',
    { payload: { productIds, productType: 'subs' } },
    z.object({ products: z.array(iapProductSchema) }),
  )
  return response.products
}

// purchase: guest-js/index.ts#L258, IapPlugin.swift#L137. The Purchase
// response (models.rs#L98) is ignored; the purchaseUpdated event drives the
// entitlement refetch.
export async function iapPurchase(productId: string): Promise<void> {
  await call('plugin:iap|purchase', { payload: { productId, productType: 'subs' } }, z.unknown())
}

// restore_purchases: guest-js/index.ts#L285, IapPlugin.swift#L192.
export async function iapRestorePurchases(): Promise<number> {
  const response = await call(
    'plugin:iap|restore_purchases',
    { payload: { productType: 'subs' } },
    z.object({ purchases: z.array(z.unknown()) }),
  )
  return response.purchases.length
}

// get_product_status: guest-js/index.ts#L393, IapPlugin.swift#L280. Only
// productId and isOwned are always present (ProductStatus: models.rs#L200).
export async function iapIsOwned(productId: string): Promise<boolean> {
  const response = await call(
    'plugin:iap|get_product_status',
    { payload: { productId, productType: 'subs' } },
    z.object({ isOwned: z.boolean() }),
  )
  return response.isOwned
}
