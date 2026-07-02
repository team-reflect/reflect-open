import { memo, type ReactElement } from 'react'
import { format } from 'date-fns'
import { addDaysIso, parseIsoDate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'

interface WeekRowProps {
  /** The ISO date of this week's first day (per the week-start setting). */
  weekStart: string
  /** The selected day when it falls in this week, else `null`. */
  selectedDay: string | null
  /** Today when it falls in this week, else `null`. */
  todayDay: string | null
  /** Select a day — drives the carousel and the route. */
  onSelect: (date: string) => void
}

/**
 * One week slide of the calendar strip: seven day-of-week / day-number cells,
 * the selected day circled, today dotted (V1's presentation). Memoized on the
 * narrowed `selectedDay`/`todayDay` props so the dozens of off-screen week
 * slides skip re-rendering when the selection moves within another week.
 */
function WeekRowComponent({
  weekStart,
  selectedDay,
  todayDay,
  onSelect,
}: WeekRowProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-[0_0_100%]">
      {Array.from({ length: 7 }, (_, index) => addDaysIso(weekStart, index)).map((day) => {
        const selected = day === selectedDay
        const isToday = day === todayDay
        return (
          <button
            key={day}
            type="button"
            aria-label={format(parseIsoDate(day), 'EEEE, MMMM do')}
            aria-current={selected ? 'date' : undefined}
            onClick={() => {
              hapticImpactLight()
              onSelect(day)
            }}
            className="flex flex-1 flex-col items-center gap-0.5 py-1"
          >
            <span className="text-[11px] font-medium text-text-muted">
              {format(parseIsoDate(day), 'EEEEE')}
            </span>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-full text-sm tabular-nums',
                selected && 'bg-primary font-semibold text-primary-foreground',
                !selected && isToday && 'font-semibold text-primary',
                !selected && !isToday && 'text-text',
              )}
            >
              {format(parseIsoDate(day), 'd')}
            </span>
            {/* Today dot (V1) — a fixed-height slot so cells stay aligned;
                shown only when today isn't the selected (circled) day. */}
            <span
              aria-hidden
              className={cn(
                'size-1 rounded-full',
                !selected && isToday ? 'bg-primary' : 'bg-transparent',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

export const WeekRow = memo(WeekRowComponent)
