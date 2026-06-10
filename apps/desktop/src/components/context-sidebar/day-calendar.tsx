import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dailyDatesInRange, hasBridge } from '@reflect/core'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatDayLabel } from '@/lib/dates'
import {
  addMonths,
  buildMonthGrid,
  monthLabel,
  monthOf,
  weekdayLabels,
} from '@/lib/month-grid'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { useRouter } from '@/routing/router'

interface DayCalendarProps {
  /** The day the sidebar describes (highlighted as selected). */
  selectedDate: string
  /** Today's live ISO date. */
  today: string
}

const WEEKDAYS = weekdayLabels()

/**
 * Compact month calendar (the old app's daily-note anchor): weeks start
 * Monday, the selected day and today are highlighted, and days that already
 * have a daily note carry a dot marker (an indexed `dailyDate` row — daily
 * files exist only once written, so a row means real content). Clicking a day
 * navigates to it; the month view follows the selected day.
 */
export function DayCalendar({ selectedDate, today }: DayCalendarProps): ReactElement {
  const { navigate } = useRouter()
  const { graph } = useGraph()

  const [month, setMonth] = useState(() => monthOf(selectedDate))
  // Render-time state adjustment (not an effect): navigating to another day
  // re-anchors the visible month before the stale grid can paint.
  const [lastSelected, setLastSelected] = useState(selectedDate)
  if (selectedDate !== lastSelected) {
    setLastSelected(selectedDate)
    setMonth(monthOf(selectedDate))
  }

  const grid = buildMonthGrid(month)
  const { data: notedDates } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'dailyDates', grid.start, grid.end],
    queryFn: () => dailyDatesInRange(grid.start, grid.end),
    enabled: hasBridge() && graph !== null,
  })
  const noted = new Set(notedDates ?? [])

  return (
    <div aria-label="Calendar">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-sm font-medium">{monthLabel(month)}</span>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(month, -1))}
            className="rounded p-1 text-text-secondary hover:bg-surface-hover"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth(addMonths(month, 1))}
            className="rounded p-1 text-text-secondary hover:bg-surface-hover"
          >
            <ChevronRight aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>

      <table className="w-full border-separate border-spacing-y-0.5 text-center">
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th
                key={weekday}
                scope="col"
                className="pb-0.5 text-[10px] font-medium text-text-muted"
              >
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.weeks.map((week) => (
            <tr key={week[0].date}>
              {week.map((cell) => {
                const isSelected = cell.date === selectedDate
                const isToday = cell.date === today
                return (
                  <td key={cell.date} className="p-0">
                    <button
                      type="button"
                      aria-label={formatDayLabel(cell.date)}
                      aria-current={isToday ? 'date' : undefined}
                      aria-pressed={isSelected}
                      onClick={() => navigate({ kind: 'daily', date: cell.date })}
                      className={cn(
                        'relative mx-auto flex size-7 items-center justify-center rounded-md text-xs tabular-nums',
                        cell.inMonth
                          ? 'text-text'
                          : 'text-text-muted',
                        isSelected
                          ? 'bg-accent font-semibold text-white'
                          : 'hover:bg-surface-hover',
                        isToday && !isSelected
                          ? 'font-semibold text-accent'
                          : null,
                      )}
                    >
                      {Number(cell.date.slice(8, 10))}
                      {noted.has(cell.date) ? (
                        <span
                          aria-hidden
                          data-testid={`note-dot-${cell.date}`}
                          className={cn(
                            'absolute bottom-0.5 size-1 rounded-full',
                            isSelected ? 'bg-white/80' : 'bg-accent',
                          )}
                        />
                      ) : null}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
