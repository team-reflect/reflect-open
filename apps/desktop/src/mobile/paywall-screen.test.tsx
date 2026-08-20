import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
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

let getProducts: () => Promise<unknown>
let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  getProducts = () => Promise.resolve({ products: [] })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setBridge({
    invoke: async (command) => {
      if (command === 'plugin:iap|get_products') {
        return await getProducts()
      }
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('PaywallScreen products', () => {
  it('shows the existing failure UI when a required product is missing', async () => {
    getProducts = () =>
      Promise.resolve({
        products: [{ productId: 'app.reflect.ios.pro.yearly', formattedPrice: '$39.99' }],
      })
    const view = await render(<PaywallScreen />, { wrapper })

    await expect.element(view.getByText(/Could not load subscription options/)).toBeVisible()
    await view.unmount()
  })

  it('shows the existing failure UI when the products query rejects', async () => {
    getProducts = () => Promise.reject(new Error('StoreKit unavailable'))
    const view = await render(<PaywallScreen />, { wrapper })

    await expect.element(view.getByText(/Could not load subscription options/)).toBeVisible()
    await view.unmount()
  })
})
