import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IAP_PRODUCT_IDS, setBridge, type IapProduct, type IpcBridge } from '@reflect/core'
import { mutationKeys, mutationScopeIds } from '@/lib/query-client'
import { PaywallScreen } from './paywall-screen'

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock('@/mobile/use-active-subscription', () => ({
  useActiveSubscription: () => ({
    value: null,
    isLoading: false,
    isError: false,
    invalidate: mocks.invalidate,
  }),
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ updateSettings: mocks.updateSettings }),
}))

const PRODUCTS: IapProduct[] = [
  { formattedPrice: '$39.99', productId: IAP_PRODUCT_IDS.yearly },
  { formattedPrice: '$4.99', productId: IAP_PRODUCT_IDS.monthly },
]

interface Deferred<T> {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let rejectPromise = (_error: Error): void => {}
  let resolvePromise = (_value: T): void => {}
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject
    resolvePromise = resolve
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}

let getProducts: () => Promise<{ products: IapProduct[] }>
let purchase: () => Promise<null>
let restore: () => Promise<{ purchases: object[] }>
let invoke = vi.fn<IpcBridge['invoke']>()
let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  getProducts = async () => ({ products: PRODUCTS })
  purchase = async () => null
  restore = async () => ({ purchases: [] })
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  invoke = vi.fn<IpcBridge['invoke']>(async (command) => {
    switch (command) {
      case 'plugin:iap|get_products':
        return await getProducts()
      case 'plugin:iap|purchase':
        return await purchase()
      case 'plugin:iap|restore_purchases':
        return await restore()
      default:
        return null
    }
  })
  setBridge({ invoke, listen: async () => () => {} })
  mocks.invalidate.mockReset()
  mocks.updateSettings.mockReset()
})

afterEach(async () => {
  setBridge(null)
  queryClient.clear()
  await cleanup()
})

describe('PaywallScreen products', () => {
  it('shows the existing failure UI when a required product is missing', async () => {
    getProducts = async () => ({ products: [PRODUCTS[0]!] })
    const view = await render(<PaywallScreen />, { wrapper })

    await expect.element(view.getByText(/Could not load subscription options/)).toBeVisible()
  })

  it('shows the existing failure UI when the products query rejects', async () => {
    getProducts = () => Promise.reject(new Error('StoreKit unavailable'))
    const view = await render(<PaywallScreen />, { wrapper })

    await expect.element(view.getByText(/Could not load subscription options/)).toBeVisible()
  })
})

describe('PaywallScreen purchase mutation', () => {
  it('purchases the yearly plan, disables every action, and invalidates on success', async () => {
    const pendingPurchase = deferred<null>()
    purchase = () => pendingPurchase.promise
    const view = await render(<PaywallScreen />, { wrapper })
    const trial = view.getByRole('button', { name: 'Start 7-day free trial' })

    await expect.element(trial).toBeVisible()
    await trial.click()

    await expect.element(trial).toBeDisabled()
    await expect.element(view.getByRole('radio', { name: /Yearly/ })).toBeDisabled()
    await expect.element(view.getByRole('radio', { name: /Monthly/ })).toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: /Already a Reflect member/ }))
      .toBeDisabled()
    await expect.element(view.getByRole('button', { name: 'Remind me later' })).toBeDisabled()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeDisabled()
    expect(view.container.querySelector('button svg.animate-spin')).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith('plugin:iap|purchase', {
      payload: { productId: IAP_PRODUCT_IDS.yearly, productType: 'subs' },
    })
    const activePurchase = queryClient
      .getMutationCache()
      .find({ exact: true, mutationKey: mutationKeys.iap.purchase })
    expect(activePurchase?.options.scope?.id).toBe(mutationScopeIds.iapAction)
    expect(activePurchase?.state.variables).toEqual({
      plan: 'yearly',
      productId: IAP_PRODUCT_IDS.yearly,
    })

    pendingPurchase.resolve(null)
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1))
    await expect.element(trial).not.toBeDisabled()
  })

  it('uses the monthly initiator and treats a rejected purchase as fail soft', async () => {
    purchase = () => Promise.reject(new Error('cancelled'))
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Start 7-day free trial' })).toBeVisible()

    await view.getByRole('radio', { name: /Monthly/ }).click()
    const trial = view.getByRole('button', { name: 'Start 7-day free trial' })
    await trial.click()

    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(invoke).toHaveBeenCalledWith('plugin:iap|purchase', {
      payload: { productId: IAP_PRODUCT_IDS.monthly, productType: 'subs' },
    })
    expect(mocks.invalidate).not.toHaveBeenCalled()
    await expect.element(trial).not.toBeDisabled()
    expect(view.getByText(/cancelled/).query()).toBeNull()
  })
})

describe('PaywallScreen restore mutation', () => {
  it('shows the no-purchase message for a zero result', async () => {
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect
      .element(view.getByText('No previous purchase found for this Apple account.'))
      .toBeVisible()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('invalidates entitlements after restoring a purchase', async () => {
    restore = async () => ({ purchases: [{}] })
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1))
    expect(view.getByText(/No previous purchase/).query()).toBeNull()
  })

  it('shows the existing retry message when restore rejects', async () => {
    restore = () => Promise.reject(new Error('offline'))
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect
      .element(view.getByText('Restore failed. Check your connection and try again.'))
      .toBeVisible()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('clears an old restore message when a purchase starts', async () => {
    const pendingPurchase = deferred<null>()
    purchase = () => pendingPurchase.promise
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()
    await view.getByRole('button', { name: 'Restore Purchases' }).click()
    await expect
      .element(view.getByText('No previous purchase found for this Apple account.'))
      .toBeVisible()

    await view.getByRole('button', { name: 'Start 7-day free trial' }).click()

    expect(view.getByText(/No previous purchase/).query()).toBeNull()
    pendingPurchase.resolve(null)
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
  })

  it('uses the shared IAP scope and only restore shows progress while restoring', async () => {
    const pendingRestore = deferred<{ purchases: object[] }>()
    restore = () => pendingRestore.promise
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect.element(view.getByRole('button', { name: 'Restoring…' })).toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: 'Start 7-day free trial' }))
      .toBeDisabled()
    expect(view.container.querySelector('button svg.animate-spin')).toBeNull()
    const activeRestore = queryClient
      .getMutationCache()
      .find({ exact: true, mutationKey: mutationKeys.iap.restore })
    expect(activeRestore?.options.scope?.id).toBe(mutationScopeIds.iapAction)

    pendingRestore.resolve({ purchases: [] })
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
  })
})
