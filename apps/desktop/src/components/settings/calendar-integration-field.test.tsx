import { page, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@reflect/core'
import type { TestOpenerService } from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestCalendarService,
  type TestCalendarService,
  type TestSettingsService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { CalendarIntegrationField } from './calendar-integration-field.tsx'

const CALENDARS = [
  { id: 'cal-work', title: 'Work', source: 'Google', color: '#ff0000' },
  { id: 'cal-home', title: 'Home', source: 'iCloud', color: null },
]

let stored: Partial<Settings>
let calendar: TestCalendarService

// The services of the rendered app; set by `renderSection`.
let opener: TestOpenerService
let settings: TestSettingsService

// The field renders only on macOS desktop, which is the test platform.
async function renderSection(): Promise<void> {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService(), calendar })
  settings = app.settings
  const view = await renderInApp(<CalendarIntegrationField />, { app, settings: stored })
  opener = view.appServices.opener
}

function calendarSwitch(): Locator {
  return page.getByRole('switch', { name: /calendar events/i })
}

beforeEach(() => {
  stored = {}
  calendar = createTestCalendarService({ status: 'notDetermined', calendars: CALENDARS })
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
      expect(settings.saves().at(-1)).toMatchObject({ calendarEnabled: true, calendarIds: [] }),
    )
    await expect.element(page.getByText('0/2 calendars selected')).toBeInTheDocument()
    expect(page.getByText('Google').query()).toBeNull()
    expect(page.getByText('iCloud').query()).toBeNull()

    await page.getByRole('button', { name: /choose calendars/i }).click()

    await expect.element(page.getByRole('dialog', { name: 'Choose calendars' })).toBeInTheDocument()
    await expect.element(page.getByText('Google')).toBeInTheDocument()
    await expect.element(page.getByText('iCloud')).toBeInTheDocument()
    await expect.element(page.getByRole('checkbox', { name: 'Work' })).toBeInTheDocument()
    await expect.element(page.getByRole('checkbox', { name: 'Home' })).toBeInTheDocument()
  })

  it('shows nothing (not "No calendars found") while the list is still loading', async () => {
    stored = { calendarEnabled: true }
    calendar.setStatus('fullAccess')
    vi.spyOn(calendar, 'listCalendars').mockReturnValue(new Promise(() => {}))
    await renderSection()

    await expect.element(calendarSwitch()).toHaveAttribute('aria-checked', 'true')
    expect(page.getByText(/no calendars found/i).query()).toBeNull()
  })

  it('shows the empty state once an empty list has actually loaded', async () => {
    stored = { calendarEnabled: true }
    calendar.setStatus('fullAccess')
    calendar.setCalendars([])
    await renderSection()

    await expect.element(page.getByText(/no calendars found/i)).toBeInTheDocument()
  })

  it('toggling a calendar persists its id and updates the count', async () => {
    stored = { calendarEnabled: true }
    calendar.setStatus('fullAccess')
    await renderSection()
    await expect.element(page.getByText('0/2 calendars selected')).toBeInTheDocument()
    await page.getByRole('button', { name: /choose calendars/i }).click()

    await page.getByRole('checkbox', { name: 'Work' }).click()

    await vi.waitFor(() =>
      expect(settings.saves().at(-1)).toMatchObject({ calendarIds: ['cal-work'] }),
    )
    await expect.element(page.getByText('1/2 calendars selected')).toBeInTheDocument()
  })

  it('counts only ids the Mac still knows, ignoring stale ones', async () => {
    stored = { calendarEnabled: true, calendarIds: ['cal-work', 'cal-gone-1', 'cal-gone-2'] }
    calendar.setStatus('fullAccess')
    await renderSection()

    await expect.element(page.getByText('1/2 calendars selected')).toBeInTheDocument()
  })

  it('denied access shows the explanation and deep-links to System Settings', async () => {
    stored = { calendarEnabled: true }
    calendar.setStatus('denied')
    await renderSection()

    const open = page.getByRole('button', { name: /open system settings/i })
    await expect.element(page.getByText(/can’t read your calendars/i)).toBeInTheDocument()

    await open.click()
    await vi.waitFor(() =>
      expect(opener.openedUrls()).toEqual([
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
      ]),
    )
  })

  it('not-yet-asked access shows a Grant button that prompts and recovers', async () => {
    stored = { calendarEnabled: true }
    calendar.setStatus('notDetermined')
    await renderSection()

    await page.getByRole('button', { name: /grant access/i }).click()

    await vi.waitFor(() => expect(calendar.accessRequests()).toBe(1))
    // The grant resolved and the invalidated auth query re-ran: the calendar
    // list replaces the permission explanation.
    await expect.element(page.getByText('0/2 calendars selected')).toBeInTheDocument()
  })
})
