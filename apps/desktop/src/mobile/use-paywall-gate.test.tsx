import { act } from '@/test-utils/act.ts'
import { focusManager } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IAP_PRODUCT_IDS,
  createAppStoreEnvironmentService,
  createClassicAccessService,
  createPaywallService,
  createSubscriptionService,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestAppStoreService,
  createTestIapService,
  createTestPlatformService,
} from '@reflect/core/testing'
import { usePaywallRequested } from '@/hooks/use-paywall-requested.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { usePaywallGate } from './use-paywall-gate.ts'

/**
 * The hook's wiring: it reads the paywall service's gate and starts the
 * checks the gate depends on. The gate's decisions live with the service.
 */

afterEach(() => {
  focusManager.setFocused(undefined)
})

function iosServices() {
  return createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService({ appPlatform: 'ios' }),
  })
}

describe('usePaywallGate', () => {
  it('follows the paywall service gate', async () => {
    const services = iosServices()
    services.mobile.appStoreEnvironment.setState({ value: 'Production' })
    const { result } = await renderHookInApp(() => usePaywallGate(), { core: services })
    expect(result.current).toBe('show')

    await act(() => {
      services.mobile.appStoreEnvironment.setState({ value: 'Sandbox' })
    })
    expect(result.current).toBe('hide')
  })

  it('starts the subscription, Reflect Classic, and install-channel checks', async () => {
    const services = iosServices()
    await renderHookInApp(() => usePaywallGate(), { core: services })

    await vi.waitFor(() => {
      expect(services.mobile.subscription.calls()).toContain('activeSubscription')
      expect(services.classicAccess.calls()).toContain('start')
      expect(services.mobile.appStoreEnvironment.calls()).toContain('environment')
    })
  })

  it('looks the subscription up again on window focus', async () => {
    const services = iosServices()
    await renderHookInApp(() => usePaywallGate(), { core: services })

    focusManager.setFocused(false)
    focusManager.setFocused(true)

    expect(services.mobile.subscription.calls()).toContain('refetch')
  })

  describe('over the real services', () => {
    function realServices() {
      const base = iosServices()
      const iap = createTestIapService()
      const appStore = createTestAppStoreService({ environment: 'Sandbox' })
      const subscription = createSubscriptionService({
        iap,
        storage: base.storage,
        clock: base.clock,
        platform: base.platform,
        logger: base.logger,
      })
      const classicAccess = createClassicAccessService({
        secretStore: base.secretStore,
        http: base.http,
        webAuth: base.webAuth,
        clock: base.clock,
        id: base.id,
        activity: base.activity,
        platform: base.platform,
        logger: base.logger,
      })
      const appStoreEnvironment = createAppStoreEnvironmentService({
        appStore,
        storage: base.storage,
        platform: base.platform,
      })
      const paywall = createPaywallService({
        subscription,
        classicAccess,
        appStoreEnvironment,
        iap,
        appStore,
        platform: base.platform,
        storage: base.storage,
      })
      return {
        iap,
        services: {
          ...base,
          iap,
          appStore,
          classicAccess,
          mobile: { ...base.mobile, subscription, appStoreEnvironment, paywall },
        },
      }
    }

    it('shows the paywall on request outside the App Store, and lifts it after a purchase', async () => {
      const { iap, services } = realServices()
      const { result } = await renderHookInApp(
        () => ({ gate: usePaywallGate(), requested: usePaywallRequested() }),
        { core: services },
      )
      await vi.waitFor(() => {
        expect(services.mobile.appStoreEnvironment.getState().value).toBe('Sandbox')
      })
      expect(result.current.gate).toBe('hide')

      await act(() => {
        result.current.requested[1](true)
      })
      await vi.waitFor(() => expect(result.current.gate).toBe('show'))

      await act(() => services.mobile.paywall.purchase(IAP_PRODUCT_IDS.monthly))
      await vi.waitFor(() => expect(result.current.gate).toBe('hide'))
      expect(iap.purchases()).toEqual([IAP_PRODUCT_IDS.monthly])
    })
  })
})
