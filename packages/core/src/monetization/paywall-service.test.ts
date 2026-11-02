import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IAP_PRODUCT_IDS } from '../ipc/iap-service.ts'
import {
  createTestAppStoreEnvironmentService,
  createTestClassicAccessService,
  createTestSubscriptionService,
  type TestAppStoreEnvironmentService,
  type TestClassicAccessService,
  type TestSubscriptionService,
} from '../testing/monetization.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import {
  createTestAppStoreService,
  createTestIapService,
  type TestAppStoreService,
  type TestIapService,
} from '../testing/plugins.ts'
import { createTestStorageService, type TestStorageService } from '../testing/storage.ts'
import {
  PAYWALL_REQUESTED_STORAGE_KEY,
  createPaywallService,
  type PaywallService,
} from './paywall-service.ts'

const YEARLY = { productId: IAP_PRODUCT_IDS.yearly, formattedPrice: '$99.99' }
const MONTHLY = { productId: IAP_PRODUCT_IDS.monthly, formattedPrice: '$9.99' }

let subscription: TestSubscriptionService
let classicAccess: TestClassicAccessService
let appStoreEnvironment: TestAppStoreEnvironmentService
let iap: TestIapService
let appStore: TestAppStoreService
let storage: TestStorageService

beforeEach(() => {
  subscription = createTestSubscriptionService()
  classicAccess = createTestClassicAccessService()
  appStoreEnvironment = createTestAppStoreEnvironmentService('Production')
  iap = createTestIapService({ products: [YEARLY, MONTHLY] })
  appStore = createTestAppStoreService()
  storage = createTestStorageService()
})

function service(appPlatform: 'ios' | 'desktop' = 'ios'): PaywallService {
  return createPaywallService({
    subscription,
    classicAccess,
    appStoreEnvironment,
    iap,
    appStore,
    platform: createTestPlatformService({ appPlatform }),
    storage,
  })
}

function classicRecord(expiresAt: number) {
  return { token: 'token', email: 'a@example.com', expiresAt, checkedAt: 0 }
}

describe('PaywallService.gate', () => {
  it('shows the paywall on an App Store install with no subscription', () => {
    expect(service().gate.get()).toBe('show')
  })

  it('hides it for a TestFlight or development install while StoreKit is pending', () => {
    appStoreEnvironment.setState({ value: 'Sandbox' })
    subscription.setState({ isLoading: true })
    expect(service().gate.get()).toBe('hide')
  })

  it('hides it for a StoreKit-configuration run', () => {
    appStoreEnvironment.setState({ value: 'Xcode' })
    expect(service().gate.get()).toBe('hide')
  })

  it('treats an unknown channel as an App Store install', () => {
    appStoreEnvironment.setState({ value: null, isError: true })
    expect(service().gate.get()).toBe('show')
  })

  it('never waits for the probe', () => {
    appStoreEnvironment.setState({ value: null, isLoading: true })
    expect(service().gate.get()).toBe('show')
  })

  it('honors an explicit request outside the App Store', () => {
    appStoreEnvironment.setState({ value: 'Sandbox' })
    const paywall = service()
    expect(paywall.gate.get()).toBe('hide')

    paywall.setRequested(true)

    expect(paywall.requested.get()).toBe(true)
    expect(storage.session.get(PAYWALL_REQUESTED_STORAGE_KEY)).toBe('true')
    expect(paywall.gate.get()).toBe('show')
  })

  it('lets a subscriber through in every channel', () => {
    subscription.setState({ value: 'yearly' })
    expect(service().gate.get()).toBe('hide')
  })

  it('lets a verified Reflect Classic subscriber through', () => {
    classicAccess.setState({ access: classicRecord(1), active: true })
    expect(service().gate.get()).toBe('hide')
  })

  it('shows the paywall once the Reflect Classic access has ended', () => {
    classicAccess.setState({ access: classicRecord(1), active: false })
    expect(service().gate.get()).toBe('show')
  })

  it('keeps the app visible while the subscription is being checked', () => {
    subscription.setState({ isLoading: true })
    expect(service().gate.get()).toBe('hide')
  })

  it('keeps the app visible while the keychain is still being read', () => {
    classicAccess.setState({ isLoading: true })
    expect(service().gate.get()).toBe('hide')
  })

  it('shows the paywall after a failed subscription check', () => {
    subscription.setState({ isError: true })
    expect(service().gate.get()).toBe('show')
  })

  it('stays out of the way off iOS', () => {
    expect(service('desktop').gate.get()).toBe('hide')
  })

  it('notifies only when the gate changes', () => {
    const paywall = service()
    const listener = vi.fn()
    const unsubscribe = paywall.gate.subscribe(listener)

    subscription.setState({ value: 'monthly' })
    expect(paywall.gate.get()).toBe('hide')
    expect(listener).toHaveBeenCalledOnce()

    classicAccess.setState({ active: true })
    appStoreEnvironment.setState({ value: 'Sandbox' })
    paywall.setRequested(true)
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    subscription.setState({ value: null })
    classicAccess.setState({ active: false })
    expect(paywall.gate.get()).toBe('show')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('subscribes to its inputs only while the gate has subscribers', () => {
    let watchers = 0
    const subscribe = subscription.subscribe
    vi.spyOn(subscription, 'subscribe').mockImplementation((listener) => {
      watchers += 1
      const unlisten = subscribe(listener)
      return () => {
        watchers -= 1
        unlisten()
      }
    })
    const paywall = service()
    paywall.gate.get()
    expect(watchers).toBe(0)

    const first = paywall.gate.subscribe(() => {})
    const second = paywall.gate.subscribe(() => {})
    expect(watchers).toBe(2)

    first()
    second()
    expect(watchers).toBe(0)
  })
})

describe('PaywallService.requested', () => {
  it('notifies only when the request changes', () => {
    const paywall = service()
    const listener = vi.fn()
    paywall.requested.subscribe(listener)

    paywall.setRequested(false)
    expect(listener).not.toHaveBeenCalled()

    paywall.setRequested(true)
    paywall.setRequested(true)
    expect(paywall.requested.get()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('PaywallService actions', () => {
  it('loads the yearly and monthly offers', async () => {
    await expect(service().products()).resolves.toEqual([YEARLY, MONTHLY])
  })

  it('purchases a plan and then looks the subscription up again', async () => {
    await service().purchase(IAP_PRODUCT_IDS.yearly)
    expect(iap.purchases()).toEqual([IAP_PRODUCT_IDS.yearly])
    expect(subscription.calls()).toEqual(['invalidate'])
  })

  it('does not look the subscription up after a failed purchase', async () => {
    vi.spyOn(iap, 'purchase').mockRejectedValue(new Error('cancelled'))
    await expect(service().purchase(IAP_PRODUCT_IDS.monthly)).rejects.toThrow('cancelled')
    expect(subscription.calls()).toEqual([])
  })

  it('restores by syncing with the App Store and refetching', async () => {
    subscription.setState({ value: 'yearly' })
    await expect(service().restore()).resolves.toBe('yearly')
    expect(appStore.calls()).toEqual(['sync'])
    expect(subscription.calls()).toEqual(['refetch'])
  })

  it('does not refetch when the sync fails', async () => {
    vi.spyOn(appStore, 'sync').mockRejectedValue(new Error('offline'))
    await expect(service().restore()).rejects.toThrow('offline')
    expect(subscription.calls()).toEqual([])
  })

  it('presents the offer-code sheet and then looks the subscription up again', async () => {
    await service().redeemCode()
    expect(appStore.calls()).toEqual(['presentOfferCodeRedeemSheet'])
    expect(subscription.calls()).toEqual(['invalidate'])
  })
})
