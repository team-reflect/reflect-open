import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { setBridge, type AppPlatform } from '@reflect/core'
import { usePaywallRequested } from '@/hooks/use-paywall-requested'
import { queryKeys } from '@/lib/query-client'
import { SettingsProvider } from '@/providers/settings-provider'
import { usePaywallGate, type PaywallGate } from './use-paywall-gate'

/**
 * The gate's contract, one case per way in and out of the paywall. The
 * install-channel rules carry the weight: the paywall must stay shown when
 * the probe cannot answer (a broken probe must never hand out a free app),
 * must lift for TestFlight and Xcode builds, and must never be *waited* on,
 * which is why the StoreKit answers in those cases are pending forever.
 */

// Hoisted above the imports, as every other graph-provider mock in this suite
// is: the factory runs before the module body assigns anything.
const graphState = vi.hoisted(() => ({ platform: 'ios' as AppPlatform }))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))
const bridgeState = vi.hoisted(() => ({ ready: true }))
vi.mock('@/hooks/use-bridge-ready', () => ({ useBridgeReady: () => bridgeState.ready }))

/** What the install-channel probe answers, or how it fails to. */
let environment: () => Promise<string>
/** What StoreKit says about each product id. */
let owned: (productId: string) => Promise<boolean>
/** The persisted settings document. */
let stored: Record<string, unknown>
/** The native purchase event callback registered by the entitlement hook. */
let emitPurchaseUpdated: ((payload: unknown) => void) | null

/** A promise that never settles, for the calls a case must not wait on. */
const rejectNeverPromises = new Set<(reason?: unknown) => void>()

function never<T>(): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    rejectNeverPromises.add(reject)
  })
}

/**
 * A StoreKit answer the case settles by hand, for the two that have to see
 * the gate before and after it arrives.
 */
function deferred<T>(): { answer: () => Promise<T>; settle: (value: T) => void } {
  const resolvers: ((value: T) => void)[] = []
  return {
    answer: () =>
      new Promise<T>((resolve) => {
        resolvers.push(resolve)
      }),
    settle: (value) => {
      for (const resolve of resolvers) {
        resolve(value)
      }
    },
  }
}

/**
 * Run a launch to the answer it should reach, then close it. What that launch
 * remembered is all the next `renderHook` starts from.
 */
async function runLaunch(gate: PaywallGate): Promise<void> {
  const launch = await renderHook(() => usePaywallGate(), { wrapper })
  await vi.waitFor(() => expect(launch.result.current).toBe(gate))
  await launch.unmount()
  queryClient.clear()
}

function installFakeBridge(): void {
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          return null
        case 'plugin:app-store|get_environment':
          return { environment: await environment() }
        case 'plugin:iap|get_product_status': {
          const payload = args['payload'] as { productId: string }
          return { isOwned: await owned(payload.productId) }
        }
        default:
          return null
      }
    },
    listen: async () => () => {},
    // `subscribeIapPurchaseUpdated` registers through the plugin channel, and
    // logs loudly when the bridge has none.
    listenPlugin: async (plugin, event, handler) => {
      if (plugin === 'iap' && event === 'purchaseUpdated') {
        emitPurchaseUpdated = handler
      }
    },
  })
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>{children}</SettingsProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  graphState.platform = 'ios'
  bridgeState.ready = true
  environment = () => Promise.resolve('Production')
  owned = () => Promise.resolve(false)
  stored = {}
  emitPurchaseUpdated = null
  localStorage.clear()
  sessionStorage.clear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(async () => {
  for (const reject of rejectNeverPromises) {
    reject(new Error('test cleanup'))
  }
  rejectNeverPromises.clear()
  await Promise.resolve()
  focusManager.setFocused(undefined)
  setBridge(null)
  queryClient.clear()
})

describe('usePaywallGate', () => {
  it('shows the paywall on an App Store install with no subscription', async () => {
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('show'))
  })

  it('hides it for a TestFlight or development install', async () => {
    environment = () => Promise.resolve('Sandbox')
    // Never answered: the channel alone has to lift the gate.
    owned = never
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('hides it for a StoreKit-configuration run', async () => {
    environment = () => Promise.resolve('Xcode')
    owned = never
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('treats an unrecognized channel as an App Store install', async () => {
    environment = () => Promise.resolve('Moon')
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('show'))
  })

  it('keeps the paywall when the probe fails', async () => {
    environment = () => Promise.reject(new Error('no app transaction'))
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('show'))
  })

  it('never waits for the probe', async () => {
    environment = never
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('show'))
  })

  it('honors an explicit request outside the App Store', async () => {
    environment = () => Promise.resolve('Sandbox')
    const { result, act } = await renderHook(
      () => ({ gate: usePaywallGate(), requested: usePaywallRequested() }),
      { wrapper },
    )
    await vi.waitFor(() => expect(result.current.gate).toBe('hide'))
    await act(() => {
      result.current.requested[1](true)
    })
    await vi.waitFor(() => expect(result.current.gate).toBe('show'))
  })

  it('lets a subscriber through in every channel', async () => {
    owned = (productId) => Promise.resolve(productId.endsWith('.yearly'))
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('lets either confirmed subscription through without waiting on its sibling', async () => {
    owned = (productId) =>
      productId.endsWith('.yearly') ? Promise.resolve(true) : never<boolean>()
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('stops waiting when StoreKit entitlement lookups time out', async () => {
    vi.useFakeTimers()
    try {
      let lookupCount = 0
      owned = () => {
        lookupCount += 1
        return never()
      }
      const hook = await renderHook(() => usePaywallGate(), { wrapper })
      expect(hook.result.current).toBe('pending')
      expect(lookupCount).toBe(2)

      await hook.act(() => vi.advanceTimersByTimeAsync(5_000))
      expect(hook.result.current).toBe('show')

      void queryClient.refetchQueries({ queryKey: queryKeys.iap.entitlements })
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(lookupCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refetches entitlements through the TanStack focus path', async () => {
    owned = () => Promise.resolve(false)
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('show'))

    const storeKit = deferred<boolean>()
    owned = storeKit.answer
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.iap.entitlements)?.fetchStatus).toBe('fetching'),
    )
    expect(result.current).toBe('show')

    storeKit.settle(true)
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('invalidates the entitlement prefix after a native purchase update', async () => {
    owned = () => Promise.resolve(false)
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('show'))
    await vi.waitFor(() => expect(emitPurchaseUpdated).not.toBeNull())

    owned = (productId) => Promise.resolve(productId.endsWith('.monthly'))
    emitPurchaseUpdated?.({ productId: 'app.reflect.ios.pro.monthly' })
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('respects a live "Remind me later" snooze', async () => {
    stored = { paywallSnoozeUntil: Date.now() + 60_000 }
    owned = never
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    await vi.waitFor(() => expect(result.current).toBe('hide'))
  })

  it('stays out of the way off iOS', async () => {
    graphState.platform = 'desktop'
    const { result } = await renderHook(() => usePaywallGate(), { wrapper })
    expect(result.current).toBe('hide')
  })

  describe('with the last launch remembered', () => {
    it('answers from the remembered channel before StoreKit says anything', async () => {
      environment = () => Promise.resolve('Sandbox')
      owned = never
      await runLaunch('hide')

      environment = never
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      // No `waitFor`: this is the whole point of the cache.
      expect(result.current).toBe('hide')
    })

    it('keeps a remembered channel when the live probe fails', async () => {
      environment = () => Promise.resolve('Sandbox')
      owned = never
      await runLaunch('hide')

      environment = () => Promise.reject(new Error('no app transaction'))
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      expect(result.current).toBe('hide')
      await vi.waitFor(() =>
        expect(queryClient.getQueryState(queryKeys.appStore.environment)?.status).toBe('error'),
      )
      expect(result.current).toBe('hide')
    })

    it('verifies a remembered channel when the bridge becomes ready later', async () => {
      environment = () => Promise.resolve('Sandbox')
      owned = never
      await runLaunch('hide')

      bridgeState.ready = false
      environment = () => Promise.resolve('Production')
      const { result, rerender } = await renderHook(() => usePaywallGate(), { wrapper })
      expect(result.current).toBe('hide')

      bridgeState.ready = true
      await rerender()
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(queryKeys.appStore.environment)).toBe('Production'),
      )
    })

    it('does not re-probe a live channel for a second observer', async () => {
      let probeCount = 0
      environment = async () => {
        probeCount += 1
        return 'Sandbox'
      }
      owned = never

      const first = await renderHook(() => usePaywallGate(), { wrapper })
      await vi.waitFor(() => expect(first.result.current).toBe('hide'))
      expect(probeCount).toBe(1)

      const second = await renderHook(() => usePaywallGate(), { wrapper })
      expect(second.result.current).toBe('hide')
      expect(probeCount).toBe(1)
    })

    it('answers from a remembered subscription before StoreKit says anything', async () => {
      owned = (productId) => Promise.resolve(productId.endsWith('.yearly'))
      await runLaunch('hide')

      environment = never
      owned = never
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      expect(result.current).toBe('hide')
    })

    it('lets the live answer overrule a subscription that lapsed', async () => {
      owned = (productId) => Promise.resolve(productId.endsWith('.yearly'))
      await runLaunch('hide')

      const storeKit = deferred<boolean>()
      owned = storeKit.answer
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      expect(result.current).toBe('hide')
      storeKit.settle(false)
      await vi.waitFor(() => expect(result.current).toBe('show'))
    })

    it('forgets a subscription StoreKit has since dropped', async () => {
      owned = (productId) => Promise.resolve(productId.endsWith('.yearly'))
      await runLaunch('hide')
      owned = () => Promise.resolve(false)
      await runLaunch('show')

      environment = never
      owned = never
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      // A remembered `yearly` would have let this launch straight in.
      expect(result.current).toBe('pending')
    })

    it('waits for live verification before trusting a remembered null', async () => {
      await runLaunch('show')

      environment = never
      owned = never
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      await vi.waitFor(() =>
        expect(queryClient.getQueryState(queryKeys.iap.entitlements)?.fetchStatus).toBe('fetching'),
      )
      expect(result.current).toBe('pending')
    })

    it('does not persist null when one entitlement fails and the sibling is negative', async () => {
      owned = (productId) => Promise.resolve(productId.endsWith('.yearly'))
      await runLaunch('hide')

      owned = (productId) =>
        productId.endsWith('.yearly')
          ? Promise.reject(new Error('StoreKit unavailable'))
          : Promise.resolve(false)
      const failedLaunch = await renderHook(() => usePaywallGate(), { wrapper })
      expect(failedLaunch.result.current).toBe('hide')
      await vi.waitFor(() =>
        expect(queryClient.getQueryState(queryKeys.iap.entitlements)?.status).toBe('error'),
      )
      await failedLaunch.unmount()
      queryClient.clear()

      environment = never
      owned = never
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      expect(result.current).toBe('hide')
    })

    it('drops a remembered channel the probe no longer recognizes', async () => {
      environment = () => Promise.resolve('Sandbox')
      await runLaunch('hide')
      environment = () => Promise.resolve('Moon')
      await runLaunch('show')

      environment = never
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      // A remembered `Sandbox` would have let this launch straight in.
      await vi.waitFor(() => expect(result.current).toBe('show'))
    })

    it('corrects a remembered Sandbox once the build reaches the App Store', async () => {
      environment = () => Promise.resolve('Sandbox')
      await runLaunch('hide')

      const probe = deferred<string>()
      environment = probe.answer
      const { result } = await renderHook(() => usePaywallGate(), { wrapper })
      expect(result.current).toBe('hide')
      probe.settle('Production')
      await vi.waitFor(() => expect(result.current).toBe('show'))
    })
  })
})
