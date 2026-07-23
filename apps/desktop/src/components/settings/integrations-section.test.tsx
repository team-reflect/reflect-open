import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { IntegrationsSection } from './integrations-section'

const openUrl = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

// A browser-mode module mock materializes value exports once, so this file
// keeps the flag statically false; the macOS-specific test lives in
// `integrations-section-macos.test.tsx`.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: false }))

vi.mock('./calendar-integration-field', () => ({
  CalendarIntegrationField: () => <div>Calendar events</div>,
}))

const settings = vi.hoisted(() => ({
  current: { contactsEnabled: false },
  update: vi.fn((patch: Record<string, unknown>) => {
    settings.current = { ...settings.current, ...patch } as typeof settings.current
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settings.current, updateSettings: settings.update }),
}))

let authorization: string
let requests: number

function installFakeBridge(): void {
  requests = 0
  setBridge({
    invoke: async (command) => {
      switch (command) {
        case 'contacts_authorization_status':
          return authorization
        case 'contacts_request_access': {
          requests += 1
          authorization = 'authorized'
          return true
        }
        default:
          throw new Error(`unexpected command ${command}`)
      }
    },
    listen: async () => () => {},
  })
}

async function renderSection(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await render(
    <QueryClientProvider client={queryClient}>
      <IntegrationsSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  authorization = 'notDetermined'
  settings.current = { contactsEnabled: false }
  settings.update.mockClear()
  openUrl.mockClear()
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
})

describe('IntegrationsSection', () => {
  it('enabling persists the opt-in and triggers the permission prompt', async () => {
    await renderSection()
    await page.getByRole('switch', { name: 'Contacts' }).click()

    expect(settings.update).toHaveBeenCalledWith({ contactsEnabled: true })
    await vi.waitFor(() => expect(requests).toBe(1))
  })

  it('disabling persists without touching the permission', async () => {
    authorization = 'authorized'
    settings.current = { contactsEnabled: true }
    await renderSection()
    await page.getByRole('switch', { name: 'Contacts' }).click()

    expect(settings.update).toHaveBeenCalledWith({ contactsEnabled: false })
    expect(requests).toBe(0)
  })

  it('offers the prompt again when enabled but never asked (e.g. after a restart)', async () => {
    settings.current = { contactsEnabled: true }
    await renderSection()

    await page.getByRole('button', { name: 'Allow contacts access' }).click()
    await vi.waitFor(() => expect(requests).toBe(1))
  })

  it('points a denied permission at System Settings', async () => {
    authorization = 'denied'
    settings.current = { contactsEnabled: true }
    await renderSection()

    await page.getByRole('button', { name: 'Open System Settings' }).click()
    expect(openUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
    )
  })

  it('renders nothing where the Contacts framework does not exist', async () => {
    authorization = 'unavailable'
    await renderSection()
    await vi.waitFor(() => expect(page.getByRole('switch').query()).toBeNull())
    expect(page.getByText('Integrations').query()).toBeNull()
  })
})
