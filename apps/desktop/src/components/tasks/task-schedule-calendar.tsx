import { useState, type ReactElement, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { type WeekStartDay } from '@reflect/core'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDayLabel } from '@/lib/dates'
import { addMonths, buildMonthGrid, monthLabel, monthOf, weekdayLabels } from '@/lib/month-grid'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'

interface TaskScheduleCalendarProps {
  /** Controlled open state (the ⌘⇧S shortcut toggles it). */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Today's live ISO date — anchors the opening month and marks "today". */
  today: string
  /** Set the selection's due date (an ISO day), or clear it with `null`. */
  onSchedule: (isoDate: string | null) => void
  /** The trigger the popover anchors to (the toolbar's "Schedule" button). */
  children: ReactNode
}

/** Maps the week-start setting to date-fns' numeric convention. */
function toWeekStartsOn(weekStartDay: WeekStartDay): 0 | 1 {
  return weekStartDay === 'sunday' ? 0 : 1
}

/**
 * The Tasks view's schedule calendar (V1): a month grid in a popover anchored to
 * the "Schedule" button. Picking a day sets the selected tasks' due date — a
 * `[[YYYY-MM-DD]]` link the projection reads — and "Clear date" removes it. The
 * picked day re-buckets the tasks (Current/Overdue/Upcoming) once the reindex
 * re-derives the date. Reuses {@link buildMonthGrid}, so it shares the daily
 * sidebar's calendar math.
 */
export function TaskScheduleCalendar({
  open,
  onOpenChange,
  today,
  onSchedule,
  children,
}: TaskScheduleCalendarProps): ReactElement {
  const { settings } = useSettings()
  const weekStartsOn = toWeekStartsOn(settings.weekStartDay)
  const [month, setMonth] = useState(() => monthOf(today))
  // Re-anchor to today's month each time the popover opens, without an effect.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setMonth(monthOf(today))
    }
  }

  const grid = buildMonthGrid(month, weekStartsOn)
  const pick = (isoDate: string | null): void => {
    onSchedule(isoDate)
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0" aria-label="Schedule">
        <header className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="text-sm font-semibold text-text">{monthLabel(month)}</div>
          <nav className="flex items-center gap-1 text-text-muted">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(addMonths(month, -1))}
              className="rounded-md p-0.5 transition-colors hover:bg-surface-hover hover:text-text"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(addMonths(month, 1))}
              className="rounded-md p-0.5 transition-colors hover:bg-surface-hover hover:text-text"
            >
              <ChevronRight className="size-4" />
            </button>
          </nav>
        </header>

        <div className="grid grid-cols-7 px-3 text-center">
          {weekdayLabels(weekStartsOn).map((weekday) => (
            <div key={weekday} className="py-1 text-xs font-medium text-text-muted">
              {weekday}
            </div>
          ))}
        </div>
        <div className="px-3 pb-1">
          {grid.weeks.map((week) => (
            <div key={week[0]!.date} className="grid grid-cols-7 text-center">
              {week.map((cell) => {
                const isToday = cell.date === today
                return (
                  <button
                    key={cell.date}
                    type="button"
                    aria-label={formatDayLabel(cell.date, settings.dateFormat)}
                    aria-current={isToday ? 'date' : undefined}
                    onClick={() => pick(cell.date)}
                    className={cn(
                      'relative m-0.5 size-8 rounded-md text-xs tabular-nums transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      !cell.inMonth && !isToday && 'text-text-muted/40',
                      isToday && 'font-bold text-accent',
                    )}
                  >
                    {Number(cell.date.slice(8, 10))}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-border px-2 py-1">
          <button
            type="button"
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none"
          >
            <X className="size-3.5" />
            Clear date
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
