import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createIapService } from './iap-service.ts'

function setup(options?: { pluginEvents?: boolean }) {
  const ipc = createTestIpcBridgeService({ pluginEvents: options?.pluginEvents ?? true })
  const logger = createTestLoggerService()
  return { ipc, logger, iap: createIapService({ ipc, logger }) }
}

describe('IapService', () => {
  it('get_products wraps the ids in the payload parameter and unwraps products', async () => {
    const { ipc, iap } = setup()
    ipc.onCommand('plugin:iap|get_products', () => ({
      products: [{ productId: 'app.reflect.ios.pro.yearly', formattedPrice: 'x' }],
    }))
    await expect(iap.getProducts(['app.reflect.ios.pro.yearly'])).resolves.toEqual([
      { productId: 'app.reflect.ios.pro.yearly', formattedPrice: 'x' },
    ])
    expect(ipc.calls()).toEqual([
      {
        command: 'plugin:iap|get_products',
        args: { payload: { productIds: ['app.reflect.ios.pro.yearly'], productType: 'subs' } },
      },
    ])
  })

  it('purchase ignores the transaction response', async () => {
    const { ipc, iap } = setup()
    ipc.onCommand('plugin:iap|purchase', () => ({ productId: 'a', purchaseState: 0 }))
    await expect(iap.purchase('a')).resolves.toBeUndefined()
    expect(ipc.calls()).toEqual([
      {
        command: 'plugin:iap|purchase',
        args: { payload: { productId: 'a', productType: 'subs' } },
      },
    ])
  })

  it('get_product_status reduces to the isOwned flag', async () => {
    const { ipc, iap } = setup()
    ipc.onCommand('plugin:iap|get_product_status', () => ({ productId: 'a', isOwned: true }))
    await expect(iap.isOwned('a')).resolves.toBe(true)
  })

  it('purchaseUpdated notifies listeners until they detach', async () => {
    const { ipc, iap } = setup()
    let updates = 0
    const unlisten = iap.subscribePurchaseUpdated(() => {
      updates += 1
    })
    await Promise.resolve()

    ipc.emitPlugin('iap', 'purchaseUpdated', { productId: 'app.reflect.ios.pro.yearly' })
    expect(updates).toBe(1)

    unlisten()
    ipc.emitPlugin('iap', 'purchaseUpdated', {})
    expect(updates).toBe(1)
  })

  it('logs a purchaseUpdated registration the bridge cannot make', async () => {
    const { iap, logger } = setup({ pluginEvents: false })
    iap.subscribePurchaseUpdated(() => {})
    await vi.waitFor(() => {
      expect(logger.getErrors().map((entry) => entry.message)).toEqual([
        'subscribing to purchaseUpdated failed',
      ])
    })
  })
})
