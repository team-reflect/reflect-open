import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  displayEvents,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarAuthorizationStatus,
} from '@reflect/core'
import { showsDayEvents } from '@reflect/app'
import { queryKeys } from '@/lib/query-client.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * TanStack Query hooks over `CalendarEventsService`
 * (docs/porting/calendar-meetings-integration.md). Events are fetched live —
 * nothing is cached beyond the query layer, and nothing is indexed.
 */

/**
 * Whether calendar queries can run at all in this environment.
 */
function useCalendarAvailable(): boolean {
  const { calendarEvents } = useAppServices()
  return calendarEvents.isAvailable()
}

/**
 * The macOS calendar permission state (never prompts). While `enabled`, the
 * service re-checks it every time the window turns visible: exactly the
 * "flip it in System Settings and come back" path.
 */
export function useCalendarAuthorization(
  enabled: boolean,
): CalendarAuthorizationStatus | undefined {
  const { calendarEvents } = useAppServices()
  const available = useCalendarAvailable()
  const { authorization } = useServiceState(calendarEvents, calendarEvents.getState)
  useEffect(() => {
    if (!enabled || !available) {
      return
    }
    return calendarEvents.watchAuthorization()
  }, [available, calendarEvents, enabled])
  return authorization ?? undefined
}

export interface CalendarsResult {
  calendars: CalendarInfo[]
  /**
   * True once a fetch has succeeded — an empty `calendars` only means "none
   * on this Mac" when this is set, not "still loading".
   */
  isLoaded: boolean
}

/**
 * Every calendar on the Mac, for the Settings section's checkbox list.
 */
export function useCalendars(enabled: boolean): CalendarsResult {
  const { calendarEvents } = useAppServices()
  const available = useCalendarAvailable()
  const query = useQuery({
    queryKey: queryKeys.calendar.calendars,
    queryFn: () => calendarEvents.listCalendars(),
    enabled: enabled && available,
  })
  return useMemo(
    () => ({ calendars: query.data ?? [], isLoaded: query.isSuccess }),
    [query.data, query.isSuccess],
  )
}

/**
 * The day's displayable events (filtered and sorted by `displayEvents`) from
 * the enabled calendars. Off (or empty-selection, or non-macOS) resolves to
 * an empty list. The minute-level `staleTime` is only a backstop — the
 * EventKit change subscription (below) invalidates on real changes.
 */
export function useDayEvents(date: string): CalendarEvent[] {
  const { settings } = useSettings()
  const { calendarEvents } = useAppServices()
  const available = useCalendarAvailable()
  const enabled = showsDayEvents(settings) && available
  const query = useQuery({
    queryKey: queryKeys.calendar.events(date, settings.calendarIds),
    queryFn: () => calendarEvents.listDayEvents(date, settings.calendarIds),
    enabled,
    staleTime: 60_000,
  })
  // Gate on `enabled`, not just the cache: the query keeps its last payload
  // after the integration is switched off, and stale meetings must not
  // linger in the sidebar.
  return useMemo(() => (enabled ? displayEvents(query.data ?? []) : []), [enabled, query.data])
}

/**
 * Re-run every calendar query when EventKit reports a change (an edit in
 * Calendar.app, an account sync, a permission flip) — live reads instead of
 * v1's ten-minute poll. Mount once per surface that shows calendar data.
 */
export function useCalendarChangeInvalidation(enabled: boolean): void {
  const queryClient = useQueryClient()
  const { calendarEvents } = useAppServices()
  const available = useCalendarAvailable()
  useEffect(() => {
    if (!enabled || !available) {
      return
    }
    return calendarEvents.subscribeChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all })
    })
  }, [available, calendarEvents, enabled, queryClient])
}
