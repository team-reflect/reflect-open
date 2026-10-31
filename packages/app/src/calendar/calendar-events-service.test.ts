import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, CalendarInfo } from '@reflect/core'
import {
  createTestCalendarService,
  createTestLoggerService,
  createTestPlatformService,
  createTestSettingsService,
} from '@reflect/core/testing'
import { createTestLifecycleService } from '../testing/lifecycle.ts'
import {
  countSelectedCalendars,
  createCalendarEventsService,
  groupCalendarsBySource,
  showsDayEvents,
} from './calendar-events-service.ts'

const CALENDARS: CalendarInfo[] = [
  { id: 'cal-work', title: 'Work', source: 'Google', color: '#ff0000' },
  { id: 'cal-home', title: 'Home', source: 'iCloud', color: null },
  { id: 'cal-team', title: 'Team', source: 'Google', color: null },
]

function eventAt(day: number, hour: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: `evt-${day}-${hour}`,
    calendarId: 'cal-work',
    title: `Meeting at ${hour}`,
    startsAt: new Date(2026, 6, day, hour, 0).getTime(),
    endsAt: new Date(2026, 6, day, hour + 1, 0).getTime(),
    allDay: false,
    recurring: false,
    availability: 'busy',
    canceled: false,
    attendees: [],
    ...overrides,
  }
}

/**
 * The service over `deps`, with a fresh test double for each one left out.
 */
function createService(deps?: Partial<Parameters<typeof createCalendarEventsService>[0]>) {
  return createCalendarEventsService({
    calendar: deps?.calendar ?? createTestCalendarService(),
    settings: deps?.settings ?? createTestSettingsService(),
    platform: deps?.platform ?? createTestPlatformService(),
    lifecycle: deps?.lifecycle ?? createTestLifecycleService(),
    logger: deps?.logger ?? createTestLoggerService(),
  })
}

describe('isAvailable', () => {
  it('is the macOS desktop shell only', () => {
    expect(createService().isAvailable()).toBe(true)
    expect(
      createService({
        platform: createTestPlatformService({ isMacosDesktop: false }),
      }).isAvailable(),
    ).toBe(false)
  })
})

describe('reads', () => {
  it('answers the calendars of the Mac', async () => {
    const calendar = createTestCalendarService({ calendars: CALENDARS })
    const service = createService({ calendar })

    await expect(service.listCalendars()).resolves.toEqual(CALENDARS)
  })

  it('lists the events of the local day from the asked calendars', async () => {
    const morning = eventAt(1, 9)
    const evening = eventAt(1, 22)
    const calendar = createTestCalendarService({
      events: [
        morning,
        evening,
        eventAt(2, 9),
        eventAt(1, 10, { id: 'other-calendar', calendarId: 'cal-home' }),
      ],
    })
    const service = createService({ calendar })

    await expect(service.listDayEvents('2026-07-01', ['cal-work'])).resolves.toEqual([
      morning,
      evening,
    ])
    await expect(service.listDayEvents('2026-07-03', ['cal-work'])).resolves.toEqual([])
  })
})

describe('subscribeChanged', () => {
  it('calls the listener on every calendar change until unsubscribed', () => {
    const calendar = createTestCalendarService()
    const service = createService({ calendar })
    let changes = 0

    const unlisten = service.subscribeChanged(() => {
      changes += 1
    })
    calendar.emitChanged()
    calendar.emitChanged()
    unlisten()
    calendar.emitChanged()

    expect(changes).toBe(2)
  })
})

describe('watchAuthorization', () => {
  it('reads the permission state now, on every page turning visible, and on every calendar change', async () => {
    const calendar = createTestCalendarService({ status: 'denied' })
    const lifecycle = createTestLifecycleService()
    const service = createService({ calendar, lifecycle })
    expect(service.getState().authorization).toBeNull()
    let notified = 0
    service.subscribe(() => {
      notified += 1
    })

    const stop = service.watchAuthorization()
    await vi.waitFor(() => expect(service.getState().authorization).toBe('denied'))

    calendar.setStatus('fullAccess')
    lifecycle.emitVisible()
    await vi.waitFor(() => expect(service.getState().authorization).toBe('fullAccess'))

    calendar.setStatus('restricted')
    calendar.emitChanged()
    await vi.waitFor(() => expect(service.getState().authorization).toBe('restricted'))
    expect(notified).toBe(3)

    stop()
    calendar.setStatus('denied')
    lifecycle.emitVisible()
    calendar.emitChanged()
    await service.listCalendars()
    expect(service.getState().authorization).toBe('restricted')
  })

  it('logs a failed read and keeps the last state', async () => {
    const logger = createTestLoggerService()
    const failure = new Error('EventKit is gone')
    const calendar = createTestCalendarService()
    vi.spyOn(calendar, 'authorizationStatus').mockRejectedValue(failure)
    const service = createService({ logger, calendar })

    service.watchAuthorization()

    await vi.waitFor(() => {
      expect(logger.getErrors()).toEqual([
        { message: 'calendar authorization read failed:', cause: failure },
      ])
    })
    expect(service.getState().authorization).toBeNull()
  })
})

describe('requestAccess', () => {
  it('prompts through the calendar', async () => {
    const calendar = createTestCalendarService({ status: 'notDetermined' })
    const service = createService({ calendar })

    await service.requestAccess()

    expect(calendar.accessRequests()).toBe(1)
    expect(service.getState().authorization).toBe('fullAccess')
  })

  it('logs a failed request and still resolves', async () => {
    const logger = createTestLoggerService()
    const failure = new Error('prompt timed out')
    const calendar = createTestCalendarService()
    vi.spyOn(calendar, 'requestAccess').mockRejectedValue(failure)
    const service = createService({ logger, calendar })

    await expect(service.requestAccess()).resolves.toBeUndefined()
    expect(logger.getErrors()).toEqual([
      { message: 'calendar access request failed:', cause: failure },
    ])
  })
})

describe('setEnabled', () => {
  it('switching on persists the setting and requests access', async () => {
    const calendar = createTestCalendarService({ status: 'notDetermined' })
    const settings = createTestSettingsService()
    await settings.whenLoaded()
    const service = createService({ calendar, settings })

    const pending = service.setEnabled(true)
    // The switch flips before the OS prompt settles.
    expect(settings.get().calendarEnabled).toBe(true)

    await expect(pending).resolves.toEqual({ accessRequested: true })
    expect(calendar.accessRequests()).toBe(1)
  })

  it('switching off persists the setting without touching the permission', async () => {
    const calendar = createTestCalendarService()
    const settings = createTestSettingsService({ calendarEnabled: true })
    await settings.whenLoaded()
    const service = createService({ calendar, settings })

    await expect(service.setEnabled(false)).resolves.toEqual({ accessRequested: false })

    expect(settings.get().calendarEnabled).toBe(false)
    expect(calendar.accessRequests()).toBe(0)
  })
})

describe('toggleCalendar', () => {
  it('adds a calendar once, at the end, and removes it again', async () => {
    const settings = createTestSettingsService({ calendarIds: ['cal-work', 'cal-home'] })
    await settings.whenLoaded()
    const service = createService({ settings })

    service.toggleCalendar('cal-team', true)
    expect(settings.get().calendarIds).toEqual(['cal-work', 'cal-home', 'cal-team'])

    service.toggleCalendar('cal-work', true)
    expect(settings.get().calendarIds).toEqual(['cal-home', 'cal-team', 'cal-work'])

    service.toggleCalendar('cal-home', false)
    expect(settings.get().calendarIds).toEqual(['cal-team', 'cal-work'])

    service.toggleCalendar('cal-gone', false)
    expect(settings.get().calendarIds).toEqual(['cal-team', 'cal-work'])
  })
})

describe('showsDayEvents', () => {
  it('needs the integration on and at least one calendar chosen', () => {
    expect(showsDayEvents({ calendarEnabled: true, calendarIds: ['cal-work'] })).toBe(true)
    expect(showsDayEvents({ calendarEnabled: true, calendarIds: [] })).toBe(false)
    expect(showsDayEvents({ calendarEnabled: false, calendarIds: ['cal-work'] })).toBe(false)
  })
})

describe('groupCalendarsBySource', () => {
  it('groups calendars by account in first-seen order', () => {
    expect(groupCalendarsBySource(CALENDARS)).toEqual([
      ['Google', [CALENDARS[0], CALENDARS[2]]],
      ['iCloud', [CALENDARS[1]]],
    ])
    expect(groupCalendarsBySource([])).toEqual([])
  })
})

describe('countSelectedCalendars', () => {
  it('counts only ids the Mac still knows, ignoring stale ones', () => {
    expect(countSelectedCalendars(CALENDARS, ['cal-work', 'cal-gone-1', 'cal-gone-2'])).toBe(1)
    expect(countSelectedCalendars(CALENDARS, [])).toBe(0)
  })
})
