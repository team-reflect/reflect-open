import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { IntegrationsSection } from './integrations-section'

// A browser-mode module mock materializes value exports once, so the macOS
// behavior needs its own file with the flag statically true
// (see `integrations-section.test.tsx` for the rest of the suite).
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))

vi.mock('./calendar-integration-field', () => ({
  CalendarIntegrationField: () => <div>Calendar events</div>,
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { contactsEnabled: false }, updateSettings: vi.fn() }),
}))

beforeEach(() => {
  setBridge({
    invoke: async (command) => {
      if (command === 'contacts_authorization_status') {
        return 'unavailable'
      }
      throw new Error(`unexpected command ${command}`)
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  setBridge(null)
})

describe('IntegrationsSection on macOS', () => {
  it('keeps calendar visible on macOS when contacts are unavailable', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <IntegrationsSection />
      </QueryClientProvider>,
    )

    await expect.element(page.getByText('Calendar events')).toBeInTheDocument()
    expect(page.getByRole('switch', { name: 'Contacts' }).query()).toBeNull()
  })
})
