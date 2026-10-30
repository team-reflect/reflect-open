import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAppStoreService,
  createIapService,
  createIpcBridgeService,
  IAP_PRODUCT_IDS,
  type AppStoreService,
  type IapService,
} from '@reflect/core'
import { createTestLoggerService } from '@reflect/core/testing'
import { createDevAssetStore } from '@/dev/dev-asset-store.ts'
import { createDevBridge } from '@/dev/dev-bridge.ts'
import { createDevFileStore } from '@/dev/dev-file-store.ts'
import { createDevIndexDb } from '@/dev/dev-index-db.ts'

let appStore: AppStoreService
let iap: IapService

/**
 * The App Store and IAP services over a fresh dev bridge.
 */
async function openPreview(): Promise<void> {
  const logger = createTestLoggerService()
  const ipc = createIpcBridgeService({
    transport: createDevBridge({
      files: createDevFileStore({}),
      index: await createDevIndexDb(),
      assets: createDevAssetStore(),
    }),
    logger,
  })
  appStore = createAppStoreService({ ipc })
  iap = createIapService({ ipc, logger })
}

beforeEach(openPreview)

describe('dev bridge App Store and IAP bindings', () => {
  it('starts in Sandbox with offers and no purchases', async () => {
    await expect(appStore.environment()).resolves.toBe('Sandbox')
    const products = await iap.getProducts(Object.values(IAP_PRODUCT_IDS))
    expect(products.map((product) => product.productId).sort()).toEqual(
      Object.values(IAP_PRODUCT_IDS).sort(),
    )
    for (const product of products) {
      expect(product.formattedPrice).toEqual(expect.any(String))
      await expect(iap.isOwned(product.productId)).resolves.toBe(false)
    }
    await expect(appStore.sync()).resolves.toBeUndefined()
    await expect(appStore.presentOfferCodeRedeemSheet()).resolves.toBeUndefined()
    await expect(iap.getProducts([IAP_PRODUCT_IDS.monthly, 'unknown'])).resolves.toEqual([
      expect.objectContaining({ productId: IAP_PRODUCT_IDS.monthly }),
    ])
  })

  it('purchases, switches plans, and owns only within the current preview', async () => {
    await iap.purchase(IAP_PRODUCT_IDS.yearly)
    await expect(iap.isOwned(IAP_PRODUCT_IDS.yearly)).resolves.toBe(true)

    await iap.purchase(IAP_PRODUCT_IDS.monthly)
    await iap.purchase(IAP_PRODUCT_IDS.monthly)
    await expect(iap.isOwned(IAP_PRODUCT_IDS.yearly)).resolves.toBe(false)
    await expect(iap.isOwned(IAP_PRODUCT_IDS.monthly)).resolves.toBe(true)

    await openPreview()
    await expect(iap.isOwned(IAP_PRODUCT_IDS.monthly)).resolves.toBe(false)
  })

  it('rejects unknown purchases without losing the current subscription', async () => {
    await iap.purchase(IAP_PRODUCT_IDS.yearly)
    await expect(iap.purchase('unknown')).rejects.toMatchObject({ kind: 'notFound' })
    await expect(iap.isOwned('unknown')).resolves.toBe(false)
    await expect(iap.isOwned(IAP_PRODUCT_IDS.yearly)).resolves.toBe(true)
  })
})
