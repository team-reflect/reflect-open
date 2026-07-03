import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider'
import { CalendarIntegrationField } from './calendar-integration-field'

// The section renders only in the macOS desktop webview; jsdom is neither.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))

const openUrl = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>(async () => {}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

const CALENDARS = [
  { id: 'cal-work', title: 'Work', source: 'Google', color: '#ff0000' },
  { id: 'cal-home', title: 'Home', source: 'iCloud', color: null },
]

let stored: Record<string, unknown>
let saved: Array<Record<string, unknown>>
let authStatus: string
let accessGranted: boolean
let calendarsResponse: () => Promise<unknown>

function installFakeBridge(): { invoked: string[] } {
  const invoked: string[] = []
  setBridge({
    invoke: async (command, args) => {
      invoked.push(command)
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          saved.push(args['settings'] as Record<string, unknown>)
          return null
        case 'calendar_authorization_status':
          return authStatus
        case 'calendar_request_access':
          if (authStatus === 'notDetermined') {
            authStatus = accessGranted ? 'fullAccess' : 'denied'
          }
          return accessGranted
        case 'calendar_list_calendars':
          return calendarsResponse()
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
  return { invoked }
}

let queryClient: QueryClient

function renderSection(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <CalendarIntegrationField />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

function calendarSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: /calendar events/i })
}

beforeEach(() => {
  stored = {}
  saved = []
  authStatus = 'notDetermined'
  accessGranted = true
  calendarsResponse = async () => CALENDARS
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  openUrl.mockClear()
  installFakeBridge()
})

afterEach(() => {
  cleanup()
  setBridge(null)
  queryClient.clear()
})

describe('CalendarIntegrationField', () => {
  it('starts switched off with no calendar detail', async () => {
    renderSection()
    await waitFor(() => expect(calendarSwitch().getAttribute('aria-checked')).toBe('false'))
    expect(screen.queryByText(/calendars/i)).toBeNull()
  })

  it('enabling requests access, persists the setting, and opens the calendar chooser dialog', async () => {
    renderSection()
    await waitFor(() => expect(calendarSwitch().getAttribute('aria-checked')).toBe('false'))

    fireEvent.click(calendarSwitch())

    await waitFor(() =>
      expect(saved.at(-1)).toMatchObject({ calendarEnabled: true, calendarIds: [] }),
    )
    await waitFor(() => expect(screen.getByText('0/2 calendars selected')).toBeTruthy())
    expect(screen.queryByText('Google')).toBeNull()
    expect(screen.queryByText('iCloud')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /choose calendars/i }))

    expect(await screen.findByRole('dialog', { name: 'Choose calendars' })).toBeTruthy()
    expect(screen.getByText('Google')).toBeTruthy()
    expect(screen.getByText('iCloud')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Work' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Home' })).toBeTruthy()
  })

  it('shows nothing (not "No calendars found") while the list is still loading', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'fullAccess'
    calendarsResponse = () => new Promise(() => {}) // never settles
    renderSection()

    await waitFor(() => expect(calendarSwitch().getAttribute('aria-checked')).toBe('true'))
    expect(screen.queryByText(/no calendars found/i)).toBeNull()
  })

  it('shows the empty state once an empty list has actually loaded', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'fullAccess'
    calendarsResponse = async () => []
    renderSection()

    await waitFor(() => expect(screen.getByText(/no calendars found/i)).toBeTruthy())
  })

  it('toggling a calendar persists its id and updates the count', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'fullAccess'
    renderSection()
    await screen.findByText('0/2 calendars selected')
    fireEvent.click(screen.getByRole('button', { name: /choose calendars/i }))
    const work = await screen.findByRole('checkbox', { name: 'Work' })

    fireEvent.click(work)

    await waitFor(() => expect(saved.at(-1)).toMatchObject({ calendarIds: ['cal-work'] }))
    await waitFor(() => expect(screen.getByText('1/2 calendars selected')).toBeTruthy())
  })

  it('counts only ids the Mac still knows, ignoring stale ones', async () => {
    stored = { calendarEnabled: true, calendarIds: ['cal-work', 'cal-gone-1', 'cal-gone-2'] }
    authStatus = 'fullAccess'
    renderSection()

    await waitFor(() => expect(screen.getByText('1/2 calendars selected')).toBeTruthy())
  })

  it('denied access shows the explanation and deep-links to System Settings', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'denied'
    renderSection()

    const open = await screen.findByRole('button', { name: /open system settings/i })
    expect(screen.getByText(/can’t read your calendars/i)).toBeTruthy()

    fireEvent.click(open)
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
      ),
    )
  })

  it('not-yet-asked access shows a Grant button that prompts and recovers', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'notDetermined'
    const { invoked } = installFakeBridge()
    renderSection()

    const grant = await screen.findByRole('button', { name: /grant access/i })
    fireEvent.click(grant)

    await waitFor(() => expect(invoked).toContain('calendar_request_access'))
    // The grant resolved and the invalidated auth query re-ran: the calendar
    // list replaces the permission explanation.
    await waitFor(() => expect(screen.getByText('0/2 calendars selected')).toBeTruthy())
  })
})
