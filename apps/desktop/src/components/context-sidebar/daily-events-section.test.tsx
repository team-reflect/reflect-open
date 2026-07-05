import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider'
import { DailyEventsSection } from './daily-events-section'

// The calendar queries only run in the macOS desktop webview; jsdom is neither.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))

// jsdom has no ResizeObserver; the dialog's input group observes itself.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver

// The add-meeting dialog reads the write generation from the graph provider.
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/graph', generation: 3 } }),
}))

// jsdom can't scroll; cmdk scrolls the highlighted suggestion into view.
window.HTMLElement.prototype.scrollIntoView = () => {}

// The action itself is covered in @reflect/core; here it is the seam the
// dialog submits through. The attendee combobox's suggestion sources are
// stubbed empty — the combobox itself is covered by its own test file.
const addMeetingToDaily = vi.hoisted(() => vi.fn(async () => ({ appended: true, createdNotes: [] })))
const suggestWikiTargets = vi.hoisted(() => vi.fn(async () => []))
const contactLinkSuggestions = vi.hoisted(() => vi.fn(async () => []))
// Identity by default: the email → note-title canonicalization is covered in
// @reflect/core; here it is the seam the chip-upgrade effect renders through.
const resolveMeetingAttendees = vi.hoisted(() =>
  vi.fn(async (attendees: readonly unknown[]) => [...attendees]),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  addMeetingToDaily,
  suggestWikiTargets,
  contactLinkSuggestions,
  resolveMeetingAttendees,
}))

const DATE = '2026-07-01'

function eventAt(hour: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  }
}

let stored: Record<string, unknown>
let events: Array<Record<string, unknown>>
let contactsAuthorization: string

function installFakeBridge(): void {
  setBridge({
    invoke: async (command) => {
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          return null
        case 'calendar_list_events':
          return events
        case 'contacts_authorization_status':
          return contactsAuthorization
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

function renderSection(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <DailyEventsSection date={DATE} />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  stored = { calendarEnabled: true, calendarIds: ['cal-work'] }
  events = []
  contactsAuthorization = 'unavailable'
  addMeetingToDaily.mockClear()
  addMeetingToDaily.mockResolvedValue({ appended: true, createdNotes: [] })
  resolveMeetingAttendees.mockClear()
  window.sessionStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  installFakeBridge()
})

afterEach(() => {
  cleanup()
  setBridge(null)
  queryClient.clear()
})

describe('DailyEventsSection', () => {
  it('lists the day’s events in start order with their times', async () => {
    events = [eventAt(14), eventAt(9)]
    renderSection()

    await waitFor(() => expect(screen.getByText('Meeting at 9')).toBeTruthy())
    const rows = screen.getAllByRole('button', { name: /meeting at/i })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Meeting at 9'),
      expect.stringContaining('Meeting at 14'),
    ])
    expect(rows[0]?.textContent).toContain('9:00am')
  })

  it('hides all-day and declined-by-me events', async () => {
    events = [
      eventAt(9),
      eventAt(10, { title: 'OOO banner', allDay: true }),
      eventAt(11, {
        title: 'Declined sync',
        attendees: [
          { name: 'Me', isCurrentUser: true, isPerson: true, status: 'declined' },
        ],
      }),
    ]
    renderSection()

    await waitFor(() => expect(screen.getByText('Meeting at 9')).toBeTruthy())
    expect(screen.queryByText('OOO banner')).toBeNull()
    expect(screen.queryByText('Declined sync')).toBeNull()
  })

  it('renders nothing while the integration is off', async () => {
    stored = { calendarEnabled: false, calendarIds: ['cal-work'] }
    events = [eventAt(9)]
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <DailyEventsSection date={DATE} />
        </SettingsProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('clicking an event opens the dialog prefilled from the event', async () => {
    events = [
      eventAt(9, {
        title: 'Standup',
        recurring: true,
        attendees: [
          { name: 'Ada Lovelace', isCurrentUser: false, isPerson: true, status: 'accepted' },
          { name: 'Me', isCurrentUser: true, isPerson: true, status: 'accepted' },
          { name: 'Room 4', isCurrentUser: false, isPerson: false, status: 'accepted' },
        ],
      }),
    ]
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /standup/i }))

    const name = await screen.findByLabelText<HTMLInputElement>('Meeting name')
    expect(name.value).toBe('Standup')
    // Suggested attendees: people who haven't declined, excluding the user.
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.queryByText('Room 4')).toBeNull()
    // Recurring events default the create-backlinked-note choice on (v1).
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
  })

  it('submitting writes the meeting through addMeetingToDaily and closes', async () => {
    events = [eventAt(9, { title: 'Standup' })]
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /standup/i }))

    const attendee = await screen.findByLabelText<HTMLInputElement>('Attendees')
    fireEvent.change(attendee, { target: { value: 'Grace Hopper' } })
    fireEvent.keyDown(attendee, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /add to daily note/i }))

    await waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith({
        date: DATE,
        title: 'Standup',
        attendees: [{ name: 'Grace Hopper' }],
        backlinkMeeting: false,
        lookupContacts: false,
        startTime: '9:00am',
        generation: 3,
      }),
    )
    await waitFor(() => expect(screen.queryByLabelText('Meeting name')).toBeNull())
  })

  it('passes invite emails and the contacts gate through to the action', async () => {
    stored = { calendarEnabled: true, calendarIds: ['cal-work'], contactsEnabled: true }
    contactsAuthorization = 'authorized'
    events = [
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
    ]
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /standup/i }))

    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getByRole('button', { name: /add to daily note/i }))

    await waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
          lookupContacts: true,
        }),
      ),
    )
  })

  it('upgrades a prefilled chip to the note that owns its invite email', async () => {
    resolveMeetingAttendees.mockResolvedValueOnce([
      { name: 'Ada Lovelace', email: 'ada@example.com' },
    ])
    events = [
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
    ]
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /standup/i }))

    await screen.findByText('Ada Lovelace')
    expect(screen.queryByText('ada@example.com')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /add to daily note/i }))
    await waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
        }),
      ),
    )
  })

  it('a removed attendee chip stays out of the submission', async () => {
    events = [
      eventAt(9, {
        title: 'Standup',
        attendees: [
          { name: 'Ada Lovelace', isCurrentUser: false, isPerson: true, status: 'accepted' },
        ],
      }),
    ]
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /standup/i }))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ada Lovelace' }))
    fireEvent.click(screen.getByRole('button', { name: /add to daily note/i }))

    await waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({ attendees: [] }),
      ),
    )
  })

  it('a failed submit surfaces the error and keeps the dialog open', async () => {
    addMeetingToDaily.mockRejectedValueOnce(new Error('disk full'))
    events = [eventAt(9, { title: 'Standup' })]
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /standup/i }))

    fireEvent.click(await screen.findByRole('button', { name: /add to daily note/i }))

    await waitFor(() => expect(screen.getByText(/disk full/i)).toBeTruthy())
    expect(screen.getByLabelText('Meeting name')).toBeTruthy()
  })
})
