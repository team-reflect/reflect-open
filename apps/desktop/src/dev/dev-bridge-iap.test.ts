import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAppStoreEnvironment,
  IAP_PRODUCT_IDS,
  iapGetProducts,
  iapIsOwned,
  iapPurchase,
  iapRestorePurchases,
  setBridge,
} from '@reflect/core'
import { createDevBridge } from '@/dev/dev-bridge'
import { createDevFileStore } from '@/dev/dev-file-store'
import { createDevIndexDb } from '@/dev/dev-index-db'

async function installPreview(): Promise<void> {
  setBridge(createDevBridge({
    platform: 'ios',
    files: createDevFileStore({}),
    index: await createDevIndexDb(),
  }))
}

beforeEach(installPreview)
afterEach(() => setBridge(null))

describe('dev bridge App Store and IAP bindings', () => {
  it('starts in Sandbox with offers and no purchases', async () => {
    await expect(getAppStoreEnvironment()).resolves.toBe('Sandbox')
    const products = await iapGetProducts(Object.values(IAP_PRODUCT_IDS))
    expect(products.map((product) => product.productId).sort()).toEqual(
      Object.values(IAP_PRODUCT_IDS).sort(),
    )
    for (const product of products) {
      expect(product.formattedPrice).toEqual(expect.any(String))
      await expect(iapIsOwned(product.productId)).resolves.toBe(false)
    }
    await expect(iapRestorePurchases()).resolves.toBe(0)
    await expect(iapGetProducts([IAP_PRODUCT_IDS.monthly, 'unknown'])).resolves.toEqual([
      expect.objectContaining({ productId: IAP_PRODUCT_IDS.monthly }),
    ])
  })

  it('purchases, switches plans, and restores only within the current preview', async () => {
    await iapPurchase(IAP_PRODUCT_IDS.yearly)
    await expect(iapIsOwned(IAP_PRODUCT_IDS.yearly)).resolves.toBe(true)
    await expect(iapRestorePurchases()).resolves.toBe(1)

    await iapPurchase(IAP_PRODUCT_IDS.monthly)
    await iapPurchase(IAP_PRODUCT_IDS.monthly)
    await expect(iapIsOwned(IAP_PRODUCT_IDS.yearly)).resolves.toBe(false)
    await expect(iapIsOwned(IAP_PRODUCT_IDS.monthly)).resolves.toBe(true)
    await expect(iapRestorePurchases()).resolves.toBe(1)

    await installPreview()
    await expect(iapIsOwned(IAP_PRODUCT_IDS.monthly)).resolves.toBe(false)
    await expect(iapRestorePurchases()).resolves.toBe(0)
  })

  it('rejects unknown purchases without losing the current subscription', async () => {
    await iapPurchase(IAP_PRODUCT_IDS.yearly)
    await expect(iapPurchase('unknown')).rejects.toMatchObject({ kind: 'notFound' })
    await expect(iapIsOwned('unknown')).resolves.toBe(false)
    await expect(iapIsOwned(IAP_PRODUCT_IDS.yearly)).resolves.toBe(true)
  })
})
