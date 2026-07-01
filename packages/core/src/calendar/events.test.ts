import { describe, expect, it } from 'vitest'
import type { CalendarAttendee, CalendarEvent } from './commands'
import { dayRange, defaultAttendeeNames, displayEvents, isDeclinedByUser } from './events'

function attendee(overrides: Partial<CalendarAttendee> = {}): CalendarAttendee {
  return {
    name: 'Ada Lovelace',
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

describe('defaultAttendeeNames', () => {
  it('suggests human, non-declined attendees, excluding the user', () => {
    const names = defaultAttendeeNames(
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
    expect(names).toEqual(['Ada Lovelace'])
  })

  it('deduplicates case-insensitively, keeping first spelling and order', () => {
    const names = defaultAttendeeNames(
      event({
        attendees: [
          attendee({ name: 'Ada Lovelace' }),
          attendee({ name: 'ada lovelace' }),
          attendee({ name: 'Grace Hopper' }),
        ],
      }),
    )
    expect(names).toEqual(['Ada Lovelace', 'Grace Hopper'])
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
