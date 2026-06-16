import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dailyDatesInRange, hasBridge, type WeekStartDay } from '@reflect/core'
import { CalendarIcon } from '@/components/icons/calendar-icon'
import { ChevronLeftIcon } from '@/components/icons/chevron-left-icon'
import { ChevronRightIcon } from '@/components/icons/chevron-right-icon'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { keybindingFor } from '@/lib/commands/app-commands'
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
import { useSettings } from '@/providers/settings-provider'
import { useRouter } from '@/routing/router'

interface DayCalendarProps {
  /** The day the sidebar describes (highlighted as selected). */
  selectedDate: string
  /** Today's live ISO date. */
  today: string
}

/** Maps the persisted `WeekStartDay` value to date-fns' numeric convention. */
function toWeekStartsOn(weekStartDay: WeekStartDay): 0 | 1 {
  return weekStartDay === 'sunday' ? 0 : 1
}

const TODAY_BINDING = keybindingFor('nav.today')

const HEADER_BUTTON_CLASS =
  'cursor-default rounded-md transition-colors duration-100 hover:bg-surface-hover hover:text-text'

/**
 * Compact month calendar in the old app's visual idiom: weeks start per the
 * week-start setting, the selected day sits on a 32px inverse square (today
 * on a grey one), and days that already have a daily note carry a dot marker
 * revealed while the pointer is over the calendar (an indexed `dailyDate`
 * row — daily files exist only once written, so a row means real content).
 * Clicking a day navigates to it; the month view follows the selected day,
 * and the calendar glyph between the month arrows jumps back to today.
 */
export function DayCalendar({ selectedDate, today }: DayCalendarProps): ReactElement {
  const { navigate } = useRouter()
  const { graph } = useGraph()
  const { settings } = useSettings()
  const weekStartsOn = toWeekStartsOn(settings.weekStartDay)

  const [month, setMonth] = useState(() => monthOf(selectedDate))
  // Render-time state adjustment (not an effect): navigating to another day
  // re-anchors the visible month before the stale grid can paint.
  const [lastSelected, setLastSelected] = useState(selectedDate)
  if (selectedDate !== lastSelected) {
    setLastSelected(selectedDate)
    setMonth(monthOf(selectedDate))
  }

  const grid = buildMonthGrid(month, weekStartsOn)
  const { data: notedDates } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'dailyDates', grid.start, grid.end],
    queryFn: () => dailyDatesInRange(grid.start, grid.end),
    enabled: hasBridge() && graph !== null,
  })
  const noted = new Set(notedDates ?? [])

  return (
    <div aria-label="Calendar" className="group min-w-36">
      <header className="flex items-center justify-between px-4 py-4">
        <div className="cursor-default text-sm font-semibold text-text">
          {monthLabel(month)}
        </div>
        {/* z-40 lifts the buttons above the WindowDragRegion strip overlaying
            the title-bar band, so clicks land instead of dragging the window
            (see NavigateArrows for the stacking contract). */}
        <nav className="relative z-40 flex items-center justify-center space-x-1 text-text-muted">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(month, -1))}
            className={HEADER_BUTTON_CLASS}
          >
            <ChevronLeftIcon />
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Jump to today"
                onClick={() => navigate({ kind: 'today' })}
                className={HEADER_BUTTON_CLASS}
              >
                <CalendarIcon />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Jump to Today {TODAY_BINDING && <ShortcutKeys binding={TODAY_BINDING} />}
            </TooltipContent>
          </Tooltip>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth(addMonths(month, 1))}
            className={HEADER_BUTTON_CLASS}
          >
            <ChevronRightIcon />
          </button>
        </nav>
      </header>

      <div>
        <div className="grid grid-cols-7 border-b border-black/5 px-4 text-center dark:border-white/10">
          {weekdayLabels(weekStartsOn).map((weekday) => (
            <div key={weekday} className="py-2 text-xs font-medium text-text">
              {weekday}
            </div>
          ))}
        </div>

        <div className="px-4 py-2">
          {grid.weeks.map((week) => (
            <div key={week[0]!.date} className="grid grid-cols-7 text-center">
              {week.map((cell) => {
                const isSelected = cell.date === selectedDate
                const isToday = cell.date === today
                return (
                  <button
                    key={cell.date}
                    type="button"
                    aria-label={formatDayLabel(cell.date, settings.dateFormat)}
                    aria-current={isToday ? 'date' : undefined}
                    aria-pressed={isSelected}
                    onClick={() => navigate({ kind: 'daily', date: cell.date })}
                    className={cn(
                      'relative cursor-default py-1.5 text-xs',
                      // Today stays fully visible even as an adjacent-month
                      // padding cell (a fix over V1, which dims it there too).
                      !cell.inMonth && !isSelected && !isToday && 'opacity-20',
                    )}
                  >
                    {isSelected || isToday ? (
                      // The 32px rounded square behind the day number.
                      <span
                        aria-hidden
                        className={cn(
                          'absolute left-1/2 top-1/2 -ml-4 -mt-4 block h-8 w-8 rounded-md',
                          isSelected ? 'bg-surface-inverse' : 'bg-surface-active',
                        )}
                      />
                    ) : null}

                    {noted.has(cell.date) ? (
                      <span
                        aria-hidden
                        data-testid={`note-dot-${cell.date}`}
                        className="pointer-events-none absolute bottom-1 left-1/2 -ml-0.5 h-1 w-1 rounded-full bg-surface-inverse/50 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-white/50"
                      />
                    ) : null}

                    <span
                      className={cn(
                        'relative block tabular-nums',
                        isSelected && 'font-bold text-text-on-inverse',
                      )}
                    >
                      {Number(cell.date.slice(8, 10))}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
