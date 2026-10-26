import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  calendarEventSchema,
  type CalendarEvent,
  type MeetingService,
  type Settings,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestCalendarService,
  createTestContactsService,
  seedNotes,
  type TestCoreServices,
  type TestCalendarService,
  type TestContactsService,
  type TestDatabaseService,
} from '@reflect/core/testing'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { DailyEventsSection } from './daily-events-section.tsx'

// The action itself is covered in @reflect/core; here it is the seam the
// dialog submits through: the real `MeetingService` over an empty index and
// in-memory note files, with the submit observed.
let addMeetingToDaily: MockInstance<MeetingService['addMeetingToDaily']>

const DATE = '2026-07-01'

function eventAt(hour: number, overrides: Record<string, unknown> = {}): CalendarEvent {
  return calendarEventSchema.parse({
    id: `evt-${hour}`,
    calendarId: 'cal-work',
    title: `Meeting at ${hour}`,
    startsAt: new Date(2026, 6, 1, hour, 0).getTime(),
    endsAt: new Date(2026, 6, 1, hour + 1, 0).getTime(),
    allDay: false,
    recurring: false,
    availability: 'busy',
    canceled: false,
    attendees: [],
    ...overrides,
  })
}

let stored: Partial<Settings>
let calendar: TestCalendarService
let contacts: TestContactsService
let database: TestDatabaseService
let core: TestCoreServices

// The meeting service writes into the open graph.
async function renderSection(): Promise<HTMLElement> {
  const { container } = await renderInApp(<DailyEventsSection date={DATE} />, {
    core,
    graph: { root: '/graph', generation: 3 },
    settings: stored,
  })
  return container
}

beforeEach(() => {
  stored = { calendarEnabled: true, calendarIds: ['cal-work'] }
  calendar = createTestCalendarService()
  contacts = createTestContactsService({ status: 'unavailable' })
  database = createWasmTestDatabaseService()
  core = createTestCoreServices({ calendar, contacts, database })
  addMeetingToDaily = vi.spyOn(core.meetings, 'addMeetingToDaily')
  return () => database.close()
})

describe('DailyEventsSection', () => {
  it('lists the day’s events in start order with their times', async () => {
    calendar.setEvents([eventAt(14), eventAt(9)])
    await renderSection()

    await expect.element(page.getByText('Meeting at 9')).toBeInTheDocument()
    const rows = page.getByRole('button', { name: /meeting at/i }).elements()
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Meeting at 9'),
      expect.stringContaining('Meeting at 14'),
    ])
    expect(rows[0]?.textContent).toContain('9:00am')
  })

  it('hides all-day and declined-by-me events', async () => {
    calendar.setEvents([
      eventAt(9),
      eventAt(10, { title: 'OOO banner', allDay: true }),
      eventAt(11, {
        title: 'Declined sync',
        attendees: [{ name: 'Me', isCurrentUser: true, isPerson: true, status: 'declined' }],
      }),
    ])
    await renderSection()

    await expect.element(page.getByText('Meeting at 9')).toBeInTheDocument()
    expect(page.getByText('OOO banner').query()).toBeNull()
    expect(page.getByText('Declined sync').query()).toBeNull()
  })

  it('renders nothing while the integration is off', async () => {
    stored = { calendarEnabled: false, calendarIds: ['cal-work'] }
    calendar.setEvents([eventAt(9)])
    const container = await renderSection()

    await vi.waitFor(() => expect(container.textContent).toBe(''))
  })

  it('clicking an event opens the dialog prefilled from the event', async () => {
    calendar.setEvents([
      eventAt(9, {
        title: 'Standup',
        recurring: true,
        attendees: [
          { name: 'Ada Lovelace', isCurrentUser: false, isPerson: true, status: 'accepted' },
          { name: 'Me', isCurrentUser: true, isPerson: true, status: 'accepted' },
          { name: 'Room 4', isCurrentUser: false, isPerson: false, status: 'accepted' },
        ],
      }),
    ])
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    const name = page.getByLabelText('Meeting name')
    await expect.element(name).toHaveValue('Standup')
    // Suggested attendees: people who haven't declined, excluding the user.
    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(page.getByText('Room 4').query()).toBeNull()
    // Recurring events default the create-backlinked-note choice on (v1).
    const checkbox = page.getByRole('checkbox')
    await expect.element(checkbox).toHaveAttribute('aria-checked', 'true')
  })

  it('submitting writes the meeting through addMeetingToDaily and closes', async () => {
    calendar.setEvents([eventAt(9, { title: 'Standup' })])
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    const attendee = page.getByLabelText('Attendees')
    await attendee.fill('Grace Hopper')
    await userEvent.keyboard('{Enter}')
    await page.getByRole('button', { name: /add to daily note/i }).click()

    await vi.waitFor(() => {
      expect(addMeetingToDaily).toHaveBeenCalledWith({
        date: DATE,
        title: 'Standup',
        attendees: [{ name: 'Grace Hopper' }],
        backlinkMeeting: false,
        lookupContacts: false,
        startTime: '9:00am',
      })
    })
    await expectLocatorToHaveCount(page.getByLabelText('Meeting name'), 0)
  })

  it('passes invite emails and the contacts gate through to the action', async () => {
    stored = { calendarEnabled: true, calendarIds: ['cal-work'], contactsEnabled: true }
    contacts.setStatus('authorized')
    calendar.setEvents([
      eventAt(9, {
        title: 'Standup',
        attendees: [
          {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            isCurrentUser: false,
            isPerson: true,
            status: 'accepted',
          },
        ],
      }),
    ])
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    await page.getByRole('button', { name: /add to daily note/i }).click()

    await vi.waitFor(() => {
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }],
          lookupContacts: true,
        }),
      )
    })
  })

  it('upgrades a prefilled chip to the note that owns its invite email', async () => {
    seedNotes(database, [
      {
        path: 'notes/ada.md',
        markdown: '# Ada Lovelace\n\n- Type: #person\n- Email: ada@example.com\n',
      },
    ])
    calendar.setEvents([
      eventAt(9, {
        title: 'Standup',
        attendees: [
          {
            name: 'ada@example.com',
            email: 'ada@example.com',
            isCurrentUser: false,
            isPerson: true,
            status: 'accepted',
          },
        ],
      }),
    ])
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(page.getByText('ada@example.com').query()).toBeNull()

    await page.getByRole('button', { name: /add to daily note/i }).click()
    await vi.waitFor(() => {
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }],
        }),
      )
    })
  })

  it('a removed attendee chip stays out of the submission', async () => {
    calendar.setEvents([
      eventAt(9, {
        title: 'Standup',
        attendees: [
          { name: 'Ada Lovelace', isCurrentUser: false, isPerson: true, status: 'accepted' },
        ],
      }),
    ])
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await page.getByRole('button', { name: 'Remove Ada Lovelace' }).click()
    await page.getByRole('button', { name: /add to daily note/i }).click()

    await vi.waitFor(() => {
      expect(addMeetingToDaily).toHaveBeenCalledWith(expect.objectContaining({ attendees: [] }))
    })
  })

  it('a failed submit surfaces the error and keeps the dialog open', async () => {
    addMeetingToDaily.mockRejectedValueOnce(new Error('disk full'))
    calendar.setEvents([eventAt(9, { title: 'Standup' })])
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await page.getByRole('button', { name: /add to daily note/i }).click()

    await expect.element(page.getByText(/disk full/i)).toBeInTheDocument()
    await expect.element(page.getByLabelText('Meeting name')).toBeInTheDocument()
  })
})
