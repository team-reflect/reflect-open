import { useState, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import type { CalendarEvent } from '@reflect/core'
import { formatTimeOfDay } from '@/lib/dates'
import { useCalendarChangeInvalidation, useDayEvents } from '@/lib/use-calendar'
import { useSettings } from '@/providers/settings-provider'
import { AddMeetingDialog } from './add-meeting-dialog'
import { SidebarSection } from './sidebar-section'

interface DailyEventsSectionProps {
  /** The day whose events to show — a validated ISO date. */
  date: string
}

/**
 * The day's meetings from Apple Calendar as a context-sidebar section
 * (docs/porting/calendar-meetings-integration.md) — v1's Events sidebar.
 * Each row's one action opens the add-meeting dialog, which writes the
 * meeting into the daily note as plain markdown. Renders nothing when the
 * integration is off, access is missing, or the day has no displayable
 * events — an empty box would just advertise an absent feature.
 */
export function DailyEventsSection({ date }: DailyEventsSectionProps): ReactElement | null {
  const { settings } = useSettings()
  useCalendarChangeInvalidation(settings.calendarEnabled)
  const events = useDayEvents(date)
  const [pendingEvent, setPendingEvent] = useState<CalendarEvent | null>(null)

  if (events.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="events" title="Events">
      <ul className="space-y-1">
        {events.map((event) => (
          <li key={`${event.id}-${event.startsAt}`}>
            <button
              type="button"
              onClick={() => setPendingEvent(event)}
              title="Add to daily note"
              className="group flex w-full items-center gap-2 rounded-md px-3 py-1 leading-5 text-text-secondary transition-colors duration-100 hover:bg-surface-hover hover:text-text"
            >
              <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                {event.title}
              </span>
              <span className="flex-none text-xs tabular-nums text-text-muted">
                {formatTimeOfDay(new Date(event.startsAt), settings.timeFormat)}
              </span>
              <span
                aria-hidden
                className="flex-none opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {pendingEvent !== null && (
        <AddMeetingDialog
          date={date}
          event={pendingEvent}
          onClose={() => setPendingEvent(null)}
        />
      )}
    </SidebarSection>
  )
}
