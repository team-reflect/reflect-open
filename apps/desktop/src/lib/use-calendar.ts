import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  calendarAuthorizationStatus,
  dayRange,
  displayEvents,
  hasBridge,
  listCalendarEvents,
  listCalendars,
  subscribeCalendarChanged,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarAuthorizationStatus,
  type Unlisten,
} from '@reflect/core'
import { isMacosDesktop } from '@/lib/platform'
import { useSettings } from '@/providers/settings-provider'

/**
 * TanStack Query hooks over the calendar bindings
 * (docs/porting/calendar-meetings-integration.md). Events are fetched live —
 * nothing is cached beyond the query layer, and nothing is indexed.
 */

/** Prefix key for every calendar query — the change-event invalidation target. */
export const CALENDAR_QUERY_PREFIX = ['calendar'] as const

export const CALENDAR_AUTH_QUERY_KEY = ['calendar', 'authorization'] as const

export const CALENDAR_LIST_QUERY_KEY = ['calendar', 'calendars'] as const

/** Whether calendar queries can run at all in this environment. */
export function calendarAvailable(): boolean {
  return hasBridge() && isMacosDesktop
}

/**
 * The macOS calendar permission state (never prompts). The state changes
 * behind Reflect's back in System Settings, so this query opts out of the
 * app-wide defaults (`staleTime: Infinity`, no focus refetch — right for
 * invalidation-driven index reads, wrong here) and re-checks every time the
 * window regains focus: exactly the "flip it in System Settings and come
 * back" path.
 */
export function useCalendarAuthorization(enabled: boolean): CalendarAuthorizationStatus | undefined {
  const query = useQuery({
    queryKey: CALENDAR_AUTH_QUERY_KEY,
    queryFn: calendarAuthorizationStatus,
    enabled: enabled && calendarAvailable(),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
  })
  return query.data
}

export interface CalendarsResult {
  calendars: CalendarInfo[]
  /**
   * True once a fetch has succeeded — an empty `calendars` only means "none
   * on this Mac" when this is set, not "still loading".
   */
  isLoaded: boolean
}

/** Every calendar on the Mac, for the Settings section's checkbox list. */
export function useCalendars(enabled: boolean): CalendarsResult {
  const query = useQuery({
    queryKey: CALENDAR_LIST_QUERY_KEY,
    queryFn: listCalendars,
    enabled: enabled && calendarAvailable(),
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
  const enabled =
    settings.calendarEnabled && settings.calendarIds.length > 0 && calendarAvailable()
  const query = useQuery({
    queryKey: ['calendar', 'events', date, settings.calendarIds],
    queryFn: () => {
      const range = dayRange(date)
      return listCalendarEvents(range.start, range.end, settings.calendarIds)
    },
    enabled,
    staleTime: 60_000,
  })
  // Gate on `enabled`, not just the cache: the query keeps its last payload
  // after the integration is switched off, and stale meetings must not
  // linger in the sidebar.
  return useMemo(
    () => (enabled ? displayEvents(query.data ?? []) : []),
    [enabled, query.data],
  )
}

/**
 * Re-run every calendar query when EventKit reports a change (an edit in
 * Calendar.app, an account sync, a permission flip) — live reads instead of
 * v1's ten-minute poll. Mount once per surface that shows calendar data.
 */
export function useCalendarChangeInvalidation(enabled: boolean): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled || !calendarAvailable()) {
      return
    }
    let unlisten: Unlisten | null = null
    let disposed = false
    void subscribeCalendarChanged(() => {
      void queryClient.invalidateQueries({ queryKey: CALENDAR_QUERY_PREFIX })
    }).then((stop) => {
      if (disposed) {
        stop()
      } else {
        unlisten = stop
      }
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled, queryClient])
}
