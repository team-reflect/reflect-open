import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLASSIC_ACCESS_SECRET,
  IAP_PRODUCT_IDS,
  setBridge,
  type signInWithClassic,
  type ClassicSignInResult,
  type IapProduct,
  type IpcBridge,
} from '@reflect/core'
import { mutationKeys, mutationScopeIds } from '@/lib/query-client.ts'
import { deferred } from '@/test-utils/deferred.ts'
import { PaywallScreen } from './paywall-screen.tsx'

type SignInOptions = Parameters<typeof signInWithClassic>[0]

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  refetch: vi.fn(),
  signInWithClassic: vi.fn<(options: SignInOptions) => Promise<ClassicSignInResult>>(),
}))

vi.mock('@/providers/graph-provider.tsx', () => ({ useGraph: () => ({ platform: 'ios' }) }))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  signInWithClassic: mocks.signInWithClassic,
}))

vi.mock('@/mobile/use-active-subscription.ts', () => ({
  useActiveSubscription: () => ({
    value: null,
    isLoading: false,
    isError: false,
    invalidate: mocks.invalidate,
  }),
  refetchActiveSubscription: mocks.refetch,
}))

const YEARLY_PRODUCT = {
  formattedPrice: '$99999.99',
  productId: IAP_PRODUCT_IDS.yearly,
} satisfies IapProduct
const MONTHLY_PRODUCT = {
  formattedPrice: '$9999.99',
  productId: IAP_PRODUCT_IDS.monthly,
} satisfies IapProduct
const PRODUCTS: IapProduct[] = [YEARLY_PRODUCT, MONTHLY_PRODUCT]

let getProducts: () => Promise<{ products: IapProduct[] }>
let purchase: () => Promise<null>
let sync: () => Promise<null>
let redeem: () => Promise<null>
let classicRecord: string | null
let webAuthCallback: string | null
let invoke = vi.fn<IpcBridge['invoke']>()
let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  getProducts = async () => ({ products: PRODUCTS })
  purchase = async () => null
  sync = async () => null
  redeem = async () => null
  classicRecord = null
  webAuthCallback = null
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  invoke = vi.fn<IpcBridge['invoke']>(async (command) => {
    switch (command) {
      case 'plugin:iap|get_products':
        return await getProducts()
      case 'plugin:iap|purchase':
        return await purchase()
      case 'plugin:app-store|sync':
        return await sync()
      case 'plugin:app-store|present_offer_code_redeem_sheet':
        return await redeem()
      case 'secret_get':
        return classicRecord
      case 'plugin:web-auth|start':
        return { url: webAuthCallback }
      default:
        return null
    }
  })
  setBridge({ invoke, listen: async () => () => {} })
  mocks.invalidate.mockReset()
  mocks.refetch.mockReset()
  mocks.refetch.mockResolvedValue(null)
  mocks.signInWithClassic.mockReset()
  mocks.signInWithClassic.mockResolvedValue({ kind: 'cancelled' })
})

afterEach(async () => {
  setBridge(null)
  queryClient.clear()
  await cleanup()
})

describe('PaywallScreen products', () => {
  it('shows the existing failure UI when a required product is missing', async () => {
    getProducts = async () => ({ products: [YEARLY_PRODUCT] })
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

describe('PaywallScreen offer code', () => {
  it('opens the in-app redemption sheet and refetches entitlements after it closes', async () => {
    const pendingRedeem = deferred<null>()
    redeem = () => pendingRedeem.promise
    const view = await render(<PaywallScreen />, { wrapper })
    const button = view.getByRole('button', { name: 'Redeem a code' })
    await expect.element(button).toBeVisible()

    await button.click()

    await expect.element(view.getByRole('button', { name: 'Opening…' })).toBeDisabled()
    await expect
      .element(view.getByRole('button', { name: 'Start 7-day free trial' }))
      .toBeDisabled()
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeDisabled()
    expect(invoke).toHaveBeenCalledWith('plugin:app-store|present_offer_code_redeem_sheet', {})
    expect(mocks.invalidate).not.toHaveBeenCalled()

    pendingRedeem.resolve(null)
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1))
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).not.toBeDisabled()
    expect(view.getByText(/Could not open the redemption sheet/).query()).toBeNull()
  })

  it('shows a retryable message when the sheet cannot be presented', async () => {
    redeem = () => Promise.reject(new Error('no active window scene'))
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).toBeVisible()

    await view.getByRole('button', { name: 'Redeem a code' }).click()

    await expect
      .element(view.getByText('Could not open the redemption sheet. Try again.'))
      .toBeVisible()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    await expect.element(view.getByRole('button', { name: 'Redeem a code' })).not.toBeDisabled()
  })

  it('clears the redeem message when a restore starts', async () => {
    redeem = () => Promise.reject(new Error('no active window scene'))
    const view = await render(<PaywallScreen />, { wrapper })
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
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect
      .element(view.getByText('No previous purchase found for this Apple account.'))
      .toBeVisible()
    expect(invoke).toHaveBeenCalledWith('plugin:app-store|sync', {})
    expect(mocks.refetch).toHaveBeenCalledWith(queryClient)
  })

  it('hides the message when the refetched entitlement names a plan', async () => {
    mocks.refetch.mockResolvedValue('yearly')
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await vi.waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(view.getByText(/No previous purchase/).query()).toBeNull()
  })

  it('shows the existing retry message when the sync rejects', async () => {
    sync = () => Promise.reject(new Error('offline'))
    const view = await render(<PaywallScreen />, { wrapper })
    await expect.element(view.getByRole('button', { name: 'Restore Purchases' })).toBeVisible()

    await view.getByRole('button', { name: 'Restore Purchases' }).click()

    await expect
      .element(view.getByText('Restore failed. Check your connection and try again.'))
      .toBeVisible()
    expect(mocks.refetch).not.toHaveBeenCalled()
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
    const pendingSync = deferred<null>()
    sync = () => pendingSync.promise
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

    pendingSync.resolve(null)
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

  /** Mirrors signInWithClassic: the sign-in sheet closes, then the subscription is read. */
  function afterSheet(result: () => Promise<ClassicSignInResult>) {
    return async (options: SignInOptions): Promise<ClassicSignInResult> => {
      const callback = await options.startWebAuth({
        url: 'https://reflect.app/oauth',
        callbackScheme: 'reflect',
        ephemeral: options.ephemeral,
      })
      if (callback === null) return { kind: 'cancelled' }
      return await result()
    }
  }

  beforeEach(() => {
    webAuthCallback = 'reflect://oauth/callback?code=code'
  })

  function progressScreen(): Element | null {
    return document.querySelector('[aria-labelledby="classic-sign-in-title"]')
  }

  async function openSignIn() {
    const view = await render(<PaywallScreen />, { wrapper })
    await view.getByRole('button', { name: CLAIM }).click()
    await view.getByRole('button', { name: SIGN_IN }).click()
    return view
  }

  it('offers signing in here or a web offer code from the claim link', async () => {
    const view = await render(<PaywallScreen />, { wrapper })

    await view.getByRole('button', { name: CLAIM }).click()

    await expect.element(view.getByRole('button', { name: SIGN_IN })).toBeVisible()
    await expect
      .element(view.getByRole('button', { name: /Get an offer code on the web/ }))
      .toBeVisible()
    await expect.element(view.getByText(/Nothing is synced with Reflect Classic/)).toBeVisible()
    expect(mocks.signInWithClassic).not.toHaveBeenCalled()
  })

  it('signs in through the shared browser session and stays quiet when cancelled', async () => {
    webAuthCallback = null
    mocks.signInWithClassic.mockImplementation(afterSheet(async () => signedIn(null)))
    let progressShown = false
    const observer = new MutationObserver(() => {
      progressShown ||= progressScreen() !== null
    })
    observer.observe(document.body, { childList: true, subtree: true })
    await openSignIn()

    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    observer.disconnect()
    expect(progressShown).toBe(false)
    expect(mocks.signInWithClassic).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: false }),
    )
    const signIn = queryClient
      .getMutationCache()
      .find({ exact: true, mutationKey: mutationKeys.classic.signIn })
    expect(signIn?.options.scope?.id).toBe(mutationScopeIds.iapAction)
    expect(progressScreen()).toBeNull()
  })

  it('shows each step after the sheet closes, then the unlocked date', async () => {
    const check = deferred<ClassicSignInResult>()
    mocks.signInWithClassic.mockImplementation(afterSheet(() => check.promise))
    const view = await openSignIn()

    await expect.element(view.getByText('Unlocking Reflect')).toBeVisible()
    await expect.element(view.getByText('Signed in to Reflect Classic')).toBeVisible()
    await expect.element(view.getByText('Checking your subscription…')).toBeVisible()
    await expect.element(view.getByText('Working out your access')).toBeVisible()

    classicRecord = JSON.stringify(signedIn('a@example.com').access)
    check.resolve(signedIn('a@example.com'))

    await expect.element(view.getByText('Reflect Pro is unlocked')).toBeVisible()
    await expect.element(view.getByText('Signed in as a@example.com')).toBeVisible()
    await expect.element(view.getByText(/^Free until /)).toBeVisible()
    await view.getByRole('button', { name: 'Start writing' }).click()
    await vi.waitFor(() => expect(progressScreen()).toBeNull())
    expect(invoke).toHaveBeenCalledWith('secret_get', { name: CLASSIC_ACCESS_SECRET })
  })

  it('offers a different account in a private session when not eligible', async () => {
    mocks.signInWithClassic.mockImplementation(
      afterSheet(async () => ({ kind: 'not-eligible', email: 'a@example.com' })),
    )
    const view = await openSignIn()

    await expect.element(view.getByText("Couldn't unlock Reflect")).toBeVisible()
    await expect.element(view.getByText('Signed in as a@example.com')).toBeVisible()
    await expect
      .element(view.getByText('No paid Reflect Classic subscription on this account'))
      .toBeVisible()
    await view.getByRole('button', { name: 'Use a different account' }).click()
    await vi.waitFor(() =>
      expect(mocks.signInWithClassic).toHaveBeenLastCalledWith(
        expect.objectContaining({ ephemeral: true }),
      ),
    )
  })

  it('shows a retryable failure and logs when the check fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.signInWithClassic.mockImplementation(
      afterSheet(() => Promise.reject(new Error('offline'))),
    )
    const view = await openSignIn()

    await expect.element(view.getByText(/Couldn't check your subscription/)).toBeVisible()
    expect(error).toHaveBeenCalledWith(
      'Verifying the Reflect Classic subscription failed',
      expect.any(Error),
    )
    await view.getByRole('button', { name: 'Back' }).click()
    await vi.waitFor(() => expect(progressScreen()).toBeNull())
    error.mockRestore()
  })

  it('says when the Reflect Classic access has ended', async () => {
    classicRecord = JSON.stringify({
      token: 'token',
      email: 'a@example.com',
      expiresAt: Date.now() - 60_000,
      checkedAt: Date.now(),
    })
    const view = await render(<PaywallScreen />, { wrapper })

    await expect
      .element(view.getByText('Your Reflect Classic access to Reflect Open has ended.'))
      .toBeVisible()
    expect(invoke).toHaveBeenCalledWith('secret_get', { name: CLASSIC_ACCESS_SECRET })
  })
})
