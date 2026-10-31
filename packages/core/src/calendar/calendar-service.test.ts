import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createCalendarService, type CalendarEvent } from './calendar-service.ts'

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

function setup() {
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const calendar = createCalendarService({ ipc, logger })
  return { ipc, logger, calendar }
}

describe('createCalendarService', () => {
  it('reads the permission state and requests access', async () => {
    const { ipc, calendar } = setup()
    ipc.onCommand('calendar_authorization_status', () => 'denied')
    ipc.onCommand('calendar_request_access', () => true)

    await expect(calendar.authorizationStatus()).resolves.toBe('denied')
    await expect(calendar.requestAccess()).resolves.toBe(true)
  })

  it('lists calendars and events with the range spread into the payload', async () => {
    const { ipc, calendar } = setup()
    const info = { id: 'cal-1', title: 'Work', source: 'iCloud', color: null }
    ipc.onCommand('calendar_list_calendars', () => [info])
    ipc.onCommand('calendar_list_events', () => [{ ...event(), attendees: [] }])

    await expect(calendar.listCalendars()).resolves.toEqual([info])
    await expect(calendar.listEvents({ start: 10, end: 20 }, ['cal-1'])).resolves.toEqual([event()])
    expect(ipc.calls().at(-1)).toEqual({
      command: 'calendar_list_events',
      args: { start: 10, end: 20, calendarIds: ['cal-1'] },
    })
  })

  it('rejects a malformed response with a parse error', async () => {
    const { ipc, calendar } = setup()
    ipc.onCommand('calendar_authorization_status', () => 'maybe')
    await expect(calendar.authorizationStatus()).rejects.toMatchObject({ kind: 'parse' })
  })

  it('notifies change listeners until they unlisten', async () => {
    const { ipc, calendar } = setup()
    let count = 0
    const unlisten = calendar.subscribeChanged(() => {
      count++
    })
    await Promise.resolve()

    ipc.emit('calendar:changed', null)
    unlisten()
    ipc.emit('calendar:changed', null)

    expect(count).toBe(1)
  })

  it('logs a failed change subscription', async () => {
    const { ipc, logger } = setup()
    vi.spyOn(ipc, 'listen').mockRejectedValue(new Error('no events'))
    const calendar = createCalendarService({ ipc, logger })
    calendar.subscribeChanged(() => {})
    await Promise.resolve()
    await Promise.resolve()

    expect(logger.getWarnings()).toHaveLength(1)
  })
})
