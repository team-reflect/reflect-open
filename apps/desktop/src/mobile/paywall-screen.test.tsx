import type { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IAP_PRODUCT_IDS,
  createPaywallService,
  type CoreServices,
  type ClassicSignInOptions,
  type ClassicSignInResult,
  type IapProduct,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestAppStoreService,
  createTestClassicAccessService,
  createTestIapService,
  createTestPlatformService,
  createTestSubscriptionService,
  type TestClassicAccessService,
  type TestLoggerService,
  type TestSubscriptionService,
} from '@reflect/core/testing'
import { mutationKeys, mutationScopeIds } from '@/lib/query-client.ts'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { PaywallScreen } from './paywall-screen.tsx'

const YEARLY_PRODUCT = {
  formattedPrice: '$99999.99',
  productId: IAP_PRODUCT_IDS.yearly,
} satisfies IapProduct
const MONTHLY_PRODUCT = {
  formattedPrice: '$9999.99',
  productId: IAP_PRODUCT_IDS.monthly,
} satisfies IapProduct
const PRODUCTS: IapProduct[] = [YEARLY_PRODUCT, MONTHLY_PRODUCT]

let getProducts: () => Promise<IapProduct[]>
let purchase: () => Promise<void>
let sync: () => Promise<void>
let redeem: () => Promise<void>
let purchases: string[]
let syncs: number
let redeems: number
let subscription: TestSubscriptionService
let classicAccess: TestClassicAccessService
let logger: TestLoggerService
let services: CoreServices
let queryClient: QueryClient

/**
 * Render the paywall over the services of the running test.
 */
async function mount(): Promise<InAppRenderResult<CoreServices>> {
  const view = await renderInApp(<PaywallScreen />, { core: services })
  queryClient = view.queryClient
  return view
}

function invalidations(): number {
  return subscription.calls().filter((call) => call === 'invalidate').length
}

function refetches(): number {
  return subscription.calls().filter((call) => call === 'refetch').length
}

beforeEach(() => {
  getProducts = () => Promise.resolve(PRODUCTS)
  purchase = async () => {}
  sync = async () => {}
  redeem = async () => {}
  purchases = []
  syncs = 0
  redeems = 0
  const base = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService({ appPlatform: 'ios' }),
  })
  logger = base.logger
  subscription = createTestSubscriptionService()
  classicAccess = createTestClassicAccessService()
  const iap = createTestIapService()
  vi.spyOn(iap, 'getProducts').mockImplementation(() => getProducts())
  vi.spyOn(iap, 'purchase').mockImplementation((productId: string) => {
    purchases.push(productId)
    return purchase()
  })
  const appStore = createTestAppStoreService()
  vi.spyOn(appStore, 'sync').mockImplementation(() => {
    syncs += 1
    return sync()
  })
  vi.spyOn(appStore, 'presentOfferCodeRedeemSheet').mockImplementation(() => {
    redeems += 1
    return redeem()
  })
  services = {
    ...base,
    classicAccess,
    mobile: {
      ...base.mobile,
      subscription,
      paywall: createPaywallService({
        subscription,
        classicAccess,
        appStoreEnvironment: base.mobile.appStoreEnvironment,
        iap,
        appStore,
        platform: base.platform,
        storage: base.storage,
      }),
    },
  }
})

describe('PaywallScreen products', () => {
  it('shows the existing failure UI when a required product is missing', async () => {
    getProducts = () => Promise.resolve([YEARLY_PRODUCT])
    const view = await mount()

    await expect.element(view.getByText(/Could not load subscription options/)).toBeVisible()
  })

  it('shows the existing failure UI when the products query rejects', async () => {
    getProducts = () => Promise.reject(new Error('StoreKit unavailable'))
    const view = await mount()

    await expect.element(view.getByText(/Could not load subscription options/)).toBeVisible()
  })
})

describe('PaywallScreen purchase mutation', () => {
  it('purchases the yearly plan, disables every action, and invalidates on success', async () => {
    const pendingPurchase = Promise.withResolvers<void>()
    purchase = () => pendingPurchase.promise
    const view = await mount()
    const trial = view.getByRole('button', { name: 'Start 7-day free trial' })

    await expect.element(trial).toBeVisible()
    await trial.click()

    await expect.element(trial).toBeDisabled()
    await expect.element(view.getByRole('radio', { name: /Yearly/ })).toBeDisabled()
    await expect.element(view.getByRole('radio', { name: /Monthly/ })).toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: /Already a Reflect member/ }))
      .toBeDisabled()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeDisabled()
    await expect.element(trial.getByTestId('spinner')).toBeInTheDocument()
    expect(purchases).toEqual([IAP_PRODUCT_IDS.yearly])
    const activePurchase = queryClient
      .getMutationCache()
      .find({ exact: true, mutationKey: mutationKeys.iap.purchase })
    expect(activePurchase?.options.scope?.id).toBe(mutationScopeIds.iapAction)
    expect(activePurchase?.state.variables).toEqual({
      plan: 'yearly',
      productId: IAP_PRODUCT_IDS.yearly,
    })

    pendingPurchase.resolve()
    await vi.waitFor(() => expect(invalidations()).toBe(1))
    await expect.element(trial).not.toBeDisabled()
  })

  it('uses the monthly initiator and treats a rejected purchase as fail soft', async () => {
    purchase = () => Promise.reject(new Error('cancelled'))
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Start 7-day free trial' })).toBeVisible()

    await view.getByRole('radio', { name: /Monthly/ }).click()
    const trial = view.getByRole('button', { name: 'Start 7-day free trial' })
    await trial.click()

    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(purchases).toEqual([IAP_PRODUCT_IDS.monthly])
    expect(invalidations()).toBe(0)
    await expect.element(trial).not.toBeDisabled()
    expect(view.getByText(/cancelled/).query()).toBeNull()
  })
})

describe('PaywallScreen offer code', () => {
  it('opens the in-app redemption sheet and refetches entitlements after it closes', async () => {
    const pendingRedeem = Promise.withResolvers<void>()
    redeem = () => pendingRedeem.promise
    const view = await mount()
    const button = view.getByRole('button', { name: 'Redeem a code' })
    await expect.element(button).toBeVisible()

    await button.click()

    await expect.element(view.getByRole('button', { name: 'Opening…' })).toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: 'Start 7-day free trial' }))
      .toBeDisabled()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeDisabled()
    expect(redeems).toBe(1)
    expect(invalidations()).toBe(0)

    pendingRedeem.resolve()
    await vi.waitFor(() => expect(invalidations()).toBe(1))
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).not.toBeDisabled()
    expect(view.getByText(/Could not open the redemption sheet/).query()).toBeNull()
  })

  it('shows a retryable message when the sheet cannot be presented', async () => {
    redeem = () => Promise.reject(new Error('no active window scene'))
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).toBeVisible()

    await view.getByRole('button', { name: 'Redeem a code' }).click()

    await expect
      .element(view.getByText('Could not open the redemption sheet. Try again.'))
      .toBeVisible()
    expect(invalidations()).toBe(0)
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).not.toBeDisabled()
  })

  it('clears the redeem message when a restore starts', async () => {
    redeem = () => Promise.reject(new Error('no active window scene'))
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).toBeVisible()
    await view.getByRole('button', { name: 'Redeem a code' }).click()
    await expect
      .element(view.getByText('Could not open the redemption sheet. Try again.'))
      .toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(view.getByText(/Could not open the redemption sheet/).query()).toBeNull()
  })
})

describe('PaywallScreen restore mutation', () => {
  it('syncs with the App Store and shows the no-purchase message when nothing is owned', async () => {
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect
      .element(view.getByText('No previous purchase found for this Apple account.'))
      .toBeVisible()
    expect(syncs).toBe(1)
    expect(refetches()).toBe(1)
  })

  it('hides the message when the refetched entitlement names a plan', async () => {
    subscription.setState({ value: 'yearly' })
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await vi.waitFor(() => expect(refetches()).toBe(1))
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(view.getByText(/No previous purchase/).query()).toBeNull()
  })

  it('shows the existing retry message when the sync rejects', async () => {
    sync = () => Promise.reject(new Error('offline'))
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect
      .element(view.getByText('Restore failed. Check your connection and try again.'))
      .toBeVisible()
    expect(refetches()).toBe(0)
  })

  it('clears an old restore message when a purchase starts', async () => {
    const pendingPurchase = Promise.withResolvers<void>()
    purchase = () => pendingPurchase.promise
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()
    await view.getByRole('button', { name: 'Restore Purchases' }).click()
    await expect
      .element(view.getByText('No previous purchase found for this Apple account.'))
      .toBeVisible()

    await view.getByRole('button', { name: 'Start 7-day free trial' }).click()

    expect(view.getByText(/No previous purchase/).query()).toBeNull()
    pendingPurchase.resolve()
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
  })

  it('uses the shared IAP scope and only restore shows progress while restoring', async () => {
    const pendingSync = Promise.withResolvers<void>()
    sync = () => pendingSync.promise
    const view = await mount()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect.element(view.getByRole('button', { name: 'Restoring…' })).toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: 'Start 7-day free trial' }))
      .toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: 'Start 7-day free trial' }).getByTestId('spinner'))
      .not.toBeInTheDocument()
    const activeRestore = queryClient
      .getMutationCache()
      .find({ exact: true, mutationKey: mutationKeys.iap.restore })
    expect(activeRestore?.options.scope?.id).toBe(mutationScopeIds.iapAction)

    pendingSync.resolve()
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
  })
})

describe('PaywallScreen Reflect Classic verification', () => {
  const CLAIM = /Already a Reflect member/
  const SIGN_IN = /Sign in here/

  function signedIn(email: string | null): Extract<ClassicSignInResult, { kind: 'signed-in' }> {
    return {
      kind: 'signed-in',
      access: { token: 'token', email, expiresAt: Date.UTC(2027, 8, 29), checkedAt: Date.now() },
    }
  }

  /**
   * Mirrors `signIn`: the sign-in sheet closes, then the subscription is read.
   */
  function afterSheet(result: () => Promise<ClassicSignInResult>) {
    return async (options: ClassicSignInOptions): Promise<ClassicSignInResult> => {
      options.onSheetClosed?.()
      return await result()
    }
  }

  function progressScreen(): Element | null {
    return document.querySelector('[aria-labelledby="classic-sign-in-title"]')
  }

  async function openSignIn() {
    const view = await mount()
    await view.getByRole('button', { name: CLAIM }).click()
    await view.getByRole('button', { name: SIGN_IN }).click()
    return view
  }

  it('offers signing in here or a web offer code from the claim link', async () => {
    const view = await mount()

    await view.getByRole('button', { name: CLAIM }).click()

    await expect.element(view.getByRole('button', { name: SIGN_IN })).toBeVisible()
    await expect
      .element(view.getByRole('button', { name: /Get an offer code on the web/ }))
      .toBeVisible()
    await expect.element(view.getByText(/Nothing is synced with Reflect Classic/)).toBeVisible()
    expect(classicAccess.signIns()).toEqual([])
  })

  it('signs in through the shared browser session and stays quiet when cancelled', async () => {
    let progressShown = false
    const observer = new MutationObserver(() => {
      progressShown ||= progressScreen() !== null
    })
    observer.observe(document.body, { childList: true, subtree: true })
    await openSignIn()

    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    observer.disconnect()
    expect(progressShown).toBe(false)
    expect(classicAccess.signIns()).toEqual([expect.objectContaining({ ephemeral: false })])
    const signIn = queryClient
      .getMutationCache()
      .find({ exact: true, mutationKey: mutationKeys.classic.signIn })
    expect(signIn?.options.scope?.id).toBe(mutationScopeIds.iapAction)
    expect(progressScreen()).toBeNull()
  })

  it('shows each step after the sheet closes, then the unlocked date', async () => {
    const check = Promise.withResolvers<ClassicSignInResult>()
    classicAccess.setSignIn(afterSheet(() => check.promise))
    const view = await openSignIn()

    await expect.element(view.getByText('Unlocking Reflect')).toBeVisible()
    await expect.element(view.getByText('Signed in to Reflect Classic')).toBeVisible()
    await expect.element(view.getByText('Checking your subscription…')).toBeVisible()
    await expect.element(view.getByText('Working out your access')).toBeVisible()

    check.resolve(signedIn('a@example.com'))

    await expect.element(view.getByText('Reflect Pro is unlocked')).toBeVisible()
    await expect.element(view.getByText('Signed in as a@example.com')).toBeVisible()
    await expect.element(view.getByText(/^Free until /)).toBeVisible()
    const reads = classicAccess.calls().filter((call) => call === 'read').length
    await view.getByRole('button', { name: 'Start writing' }).click()
    await vi.waitFor(() => expect(progressScreen()).toBeNull())
    expect(classicAccess.calls().filter((call) => call === 'read')).toHaveLength(reads + 1)
  })

  it('offers a different account in a private session when not eligible', async () => {
    classicAccess.setSignIn(
      afterSheet(() => Promise.resolve({ kind: 'not-eligible', email: 'a@example.com' })),
    )
    const view = await openSignIn()

    await expect.element(view.getByText("Couldn't unlock Reflect")).toBeVisible()
    await expect.element(view.getByText('Signed in as a@example.com')).toBeVisible()
    await expect
      .element(view.getByText('No paid Reflect Classic subscription on this account'))
      .toBeVisible()
    await view.getByRole('button', { name: 'Use a different account' }).click()
    await vi.waitFor(() => {
      expect(classicAccess.signIns().at(-1)).toEqual(expect.objectContaining({ ephemeral: true }))
    })
  })

  it('shows a retryable failure and logs when the check fails', async () => {
    classicAccess.setSignIn(afterSheet(() => Promise.reject(new Error('offline'))))
    const view = await openSignIn()

    await expect.element(view.getByText(/Couldn't check your subscription/)).toBeVisible()
    expect(logger.getErrors()).toContainEqual({
      message: 'Verifying the Reflect Classic subscription failed',
      cause: expect.any(Error) as Error,
    })
    await view.getByRole('button', { name: 'Back' }).click()
    await vi.waitFor(() => expect(progressScreen()).toBeNull())
  })

  it('says when the Reflect Classic access has ended', async () => {
    classicAccess.setState({
      access: { token: 'token', email: 'a@example.com', expiresAt: 1, checkedAt: 0 },
      active: false,
    })
    const view = await mount()

    await expect
      .element(view.getByText('Your Reflect Classic access to Reflect Open has ended.'))
      .toBeVisible()
    expect(classicAccess.calls()).toContain('start')
  })
})
