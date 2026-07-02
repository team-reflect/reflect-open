import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { IntegrationsSection } from './integrations-section'

const openUrl = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

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

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
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
  cleanup()
  setBridge(null)
})

describe('IntegrationsSection', () => {
  it('enabling persists the opt-in and triggers the permission prompt', async () => {
    renderSection()
    fireEvent.click(await screen.findByRole('switch', { name: 'Contacts' }))

    expect(settings.update).toHaveBeenCalledWith({ contactsEnabled: true })
    await waitFor(() => expect(requests).toBe(1))
  })

  it('disabling persists without touching the permission', async () => {
    authorization = 'authorized'
    settings.current = { contactsEnabled: true }
    renderSection()
    fireEvent.click(await screen.findByRole('switch', { name: 'Contacts' }))

    expect(settings.update).toHaveBeenCalledWith({ contactsEnabled: false })
    expect(requests).toBe(0)
  })

  it('offers the prompt again when enabled but never asked (e.g. after a restart)', async () => {
    settings.current = { contactsEnabled: true }
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Allow contacts access' }))
    await waitFor(() => expect(requests).toBe(1))
  })

  it('points a denied permission at System Settings', async () => {
    authorization = 'denied'
    settings.current = { contactsEnabled: true }
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Open System Settings' }))
    expect(openUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
    )
  })

  it('renders nothing where the Contacts framework does not exist', async () => {
    authorization = 'unavailable'
    renderSection()
    await waitFor(() => expect(screen.queryByRole('switch')).toBeNull())
    expect(screen.queryByText('System integrations')).toBeNull()
  })
})
