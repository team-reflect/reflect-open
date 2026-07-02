import { describe, expect, it } from 'vitest'
import type { CalendarAttendee, CalendarEvent } from './commands'
import { dayRange, defaultAttendees, displayEvents, isDeclinedByUser } from './events'

function attendee(overrides: Partial<CalendarAttendee> = {}): CalendarAttendee {
  return {
    name: 'Ada Lovelace',
    email: null,
    isCurrentUser: false,
    isPerson: true,
    status: 'accepted',
    ...overrides,
  }
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    calendarId: 'cal-1',
    title: 'Standup',
    startsAt: 1_000,
    endsAt: 2_000,
    allDay: false,
    recurring: false,
    availability: 'busy',
    canceled: false,
    attendees: [],
    ...overrides,
  }
}

describe('isDeclinedByUser', () => {
  it('is true only when the current user declined', () => {
    expect(isDeclinedByUser(event())).toBe(false)
    expect(
      isDeclinedByUser(event({ attendees: [attendee({ status: 'declined' })] })),
    ).toBe(false)
    expect(
      isDeclinedByUser(
        event({ attendees: [attendee({ isCurrentUser: true, status: 'declined' })] }),
      ),
    ).toBe(true)
  })
})

describe('displayEvents', () => {
  it('drops all-day, canceled, and user-declined events', () => {
    const keep = event({ id: 'keep' })
    const events = [
      keep,
      event({ id: 'all-day', allDay: true }),
      event({ id: 'canceled', canceled: true }),
      event({
        id: 'declined',
        attendees: [attendee({ isCurrentUser: true, status: 'declined' })],
      }),
    ]
    expect(displayEvents(events).map((entry) => entry.id)).toEqual(['keep'])
  })

  it('drops untitled events and busy-block placeholders (v1 rules)', () => {
    const events = [
      event({ id: 'keep' }),
      event({ id: 'untitled', title: '  ' }),
      event({ id: 'block', title: 'Block' }),
      event({ id: 'busy', title: 'BUSY' }),
    ]
    expect(displayEvents(events).map((entry) => entry.id)).toEqual(['keep'])
  })

  it('shows an event once when two enabled calendars carry it', () => {
    const events = [
      event({ id: 'evt-1', calendarId: 'cal-a' }),
      event({ id: 'evt-1', calendarId: 'cal-b' }),
      event({ id: 'evt-1', calendarId: 'cal-a', startsAt: 5_000, endsAt: 6_000 }),
    ]
    // Same id at a different start is a different occurrence, not a dup.
    expect(displayEvents(events)).toHaveLength(2)
  })

  it('sorts by start time, then title', () => {
    const events = [
      event({ id: 'late', title: 'Retro', startsAt: 3_000 }),
      event({ id: 'early-b', title: 'Beta sync', startsAt: 1_000 }),
      event({ id: 'early-a', title: 'Alpha sync', startsAt: 1_000 }),
    ]
    expect(displayEvents(events).map((entry) => entry.id)).toEqual([
      'early-a',
      'early-b',
      'late',
    ])
  })
})

describe('defaultAttendees', () => {
  it('suggests human, non-declined attendees, excluding the user', () => {
    const attendees = defaultAttendees(
      event({
        attendees: [
          attendee({ name: 'Ada Lovelace' }),
          attendee({ name: 'Me', isCurrentUser: true }),
          attendee({ name: 'Conference Room 4', isPerson: false }),
          attendee({ name: 'Flaky Fred', status: 'declined' }),
          attendee({ name: '   ' }),
        ],
      }),
    )
    expect(attendees).toEqual([{ name: 'Ada Lovelace' }])
  })

  it('carries the invite email for the contacts lookup', () => {
    const attendees = defaultAttendees(
      event({
        attendees: [
          attendee({ name: 'Ada Lovelace', email: 'ada@example.com' }),
          attendee({ name: 'Grace Hopper' }),
        ],
      }),
    )
    expect(attendees).toEqual([
      { name: 'Ada Lovelace', email: 'ada@example.com' },
      { name: 'Grace Hopper' },
    ])
  })

  it('deduplicates case-insensitively, keeping first spelling and order', () => {
    const attendees = defaultAttendees(
      event({
        attendees: [
          attendee({ name: 'Ada Lovelace' }),
          attendee({ name: 'ada lovelace' }),
          attendee({ name: 'Grace Hopper' }),
        ],
      }),
    )
    expect(attendees).toEqual([{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }])
  })
})

describe('dayRange', () => {
  it('spans local midnight to the following midnight', () => {
    const { start, end } = dayRange('2026-07-01')
    expect(start).toBe(new Date(2026, 6, 1).getTime())
    expect(end).toBe(new Date(2026, 6, 2).getTime())
  })

  it('rolls over month boundaries', () => {
    const { end } = dayRange('2026-01-31')
    expect(end).toBe(new Date(2026, 1, 1).getTime())
  })

  it('rejects a non-ISO date', () => {
    expect(() => dayRange('July 1')).toThrow('ISO YYYY-MM-DD')
  })
})
