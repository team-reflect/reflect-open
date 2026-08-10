import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from './bridge'
import {
  iapGetProducts,
  iapIsOwned,
  iapPurchase,
  iapRestorePurchases,
  subscribeIapPurchaseUpdated,
} from './iap-plugin'

afterEach(() => {
  setBridge(null)
})

function bridgeReturning(response: unknown) {
  const invoke = vi.fn().mockResolvedValue(response)
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

describe('iap plugin bindings', () => {
  it('get_products wraps the ids in the payload parameter and unwraps products', async () => {
    const invoke = bridgeReturning({
      products: [{ productId: 'app.reflect.ios.pro.yearly', formattedPrice: 'x' }],
    })
    await expect(iapGetProducts(['app.reflect.ios.pro.yearly'])).resolves.toEqual([
      { productId: 'app.reflect.ios.pro.yearly', formattedPrice: 'x' },
    ])
    expect(invoke).toHaveBeenCalledWith('plugin:iap|get_products', {
      payload: { productIds: ['app.reflect.ios.pro.yearly'], productType: 'subs' },
    })
  })

  it('purchase ignores the transaction response', async () => {
    const invoke = bridgeReturning({ productId: 'a', purchaseState: 0 })
    await expect(iapPurchase('a')).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('plugin:iap|purchase', {
      payload: { productId: 'a', productType: 'subs' },
    })
  })

  it('restore_purchases reduces to the entitlement count', async () => {
    bridgeReturning({ purchases: [{}, {}] })
    await expect(iapRestorePurchases()).resolves.toBe(2)
  })

  it('get_product_status reduces to the isOwned flag', async () => {
    bridgeReturning({ productId: 'a', isOwned: true })
    await expect(iapIsOwned('a')).resolves.toBe(true)
  })

  it('purchaseUpdated registers on the plugin listener channel and detaches locally', async () => {
    let emit: (payload: unknown) => void = () => {}
    const listenPlugin = vi.fn(
      async (_plugin: string, _event: string, handler: (payload: unknown) => void) => {
        emit = handler
      },
    )
    setBridge({ invoke: async () => null, listen: async () => () => {}, listenPlugin })

    const handler = vi.fn()
    const subscription = subscribeIapPurchaseUpdated(handler)
    await subscription.ready
    expect(listenPlugin).toHaveBeenCalledWith('iap', 'purchaseUpdated', expect.any(Function))

    emit({ productId: 'app.reflect.ios.pro.yearly' })
    expect(handler).toHaveBeenCalledTimes(1)

    // Unlisten is a local detach (the shared native registration stays):
    // later events must not reach the handler anymore.
    subscription.unlisten()
    emit({ productId: 'app.reflect.ios.pro.yearly' })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
