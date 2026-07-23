import { render } from 'vitest-browser-react'
import { page, type Locator } from 'vitest/browser'
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

async function renderSection(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <CalendarIntegrationField />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

function calendarSwitch(): Locator {
  return page.getByRole('switch', { name: /calendar events/i })
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
  setBridge(null)
  queryClient.clear()
})

describe('CalendarIntegrationField', () => {
  it('starts switched off with no calendar detail', async () => {
    await renderSection()
    await expect.element(calendarSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(page.getByText(/calendars/i).query()).toBeNull()
  })

  it('enabling requests access, persists the setting, and opens the calendar chooser dialog', async () => {
    await renderSection()
    await expect.element(calendarSwitch()).toHaveAttribute('aria-checked', 'false')

    await calendarSwitch().click()

    await vi.waitFor(() =>
      expect(saved.at(-1)).toMatchObject({ calendarEnabled: true, calendarIds: [] }),
    )
    await expect.element(page.getByText('0/2 calendars selected')).toBeInTheDocument()
    expect(page.getByText('Google').query()).toBeNull()
    expect(page.getByText('iCloud').query()).toBeNull()

    await page.getByRole('button', { name: /choose calendars/i }).click()

    await expect
      .element(page.getByRole('dialog', { name: 'Choose calendars' }))
      .toBeInTheDocument()
    await expect.element(page.getByText('Google')).toBeInTheDocument()
    await expect.element(page.getByText('iCloud')).toBeInTheDocument()
    await expect.element(page.getByRole('checkbox', { name: 'Work' })).toBeInTheDocument()
    await expect.element(page.getByRole('checkbox', { name: 'Home' })).toBeInTheDocument()
  })

  it('shows nothing (not "No calendars found") while the list is still loading', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'fullAccess'
    calendarsResponse = () => new Promise(() => {}) // never settles
    await renderSection()

    await expect.element(calendarSwitch()).toHaveAttribute('aria-checked', 'true')
    expect(page.getByText(/no calendars found/i).query()).toBeNull()
  })

  it('shows the empty state once an empty list has actually loaded', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'fullAccess'
    calendarsResponse = async () => []
    await renderSection()

    await expect.element(page.getByText(/no calendars found/i)).toBeInTheDocument()
  })

  it('toggling a calendar persists its id and updates the count', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'fullAccess'
    await renderSection()
    await expect.element(page.getByText('0/2 calendars selected')).toBeInTheDocument()
    await page.getByRole('button', { name: /choose calendars/i }).click()

    await page.getByRole('checkbox', { name: 'Work' }).click()

    await vi.waitFor(() => expect(saved.at(-1)).toMatchObject({ calendarIds: ['cal-work'] }))
    await expect.element(page.getByText('1/2 calendars selected')).toBeInTheDocument()
  })

  it('counts only ids the Mac still knows, ignoring stale ones', async () => {
    stored = { calendarEnabled: true, calendarIds: ['cal-work', 'cal-gone-1', 'cal-gone-2'] }
    authStatus = 'fullAccess'
    await renderSection()

    await expect.element(page.getByText('1/2 calendars selected')).toBeInTheDocument()
  })

  it('denied access shows the explanation and deep-links to System Settings', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'denied'
    await renderSection()

    const open = page.getByRole('button', { name: /open system settings/i })
    await expect.element(page.getByText(/can’t read your calendars/i)).toBeInTheDocument()

    await open.click()
    await vi.waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
      ),
    )
  })

  it('not-yet-asked access shows a Grant button that prompts and recovers', async () => {
    stored = { calendarEnabled: true }
    authStatus = 'notDetermined'
    const { invoked } = installFakeBridge()
    await renderSection()

    await page.getByRole('button', { name: /grant access/i }).click()

    await vi.waitFor(() => expect(invoked).toContain('calendar_request_access'))
    // The grant resolved and the invalidated auth query re-ran: the calendar
    // list replaces the permission explanation.
    await expect.element(page.getByText('0/2 calendars selected')).toBeInTheDocument()
  })
})
