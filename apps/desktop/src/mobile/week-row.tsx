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
 * the selected day circled, today dotted (V1's presentation). The selection
 * circle is a single shared element that slides between the row's days.
 * Memoized on the narrowed `selectedDay`/`todayDay` props so the dozens of
 * off-screen week slides skip re-rendering when the selection moves within
 * another week.
 */
function WeekRowComponent({
  weekStart,
  selectedDay,
  todayDay,
  onSelect,
}: WeekRowProps): ReactElement {
  const days = Array.from({ length: 7 }, (_, index) => addDaysIso(weekStart, index))
  const selectedIndex = selectedDay ? days.indexOf(selectedDay) : -1
  return (
    <div className="relative flex min-w-0 flex-[0_0_100%]">
      {selectedIndex >= 0 && (
        /* One circle per row, translated to the selected column, so moving
           within the week slides it behind the day numbers (the buttons are
           `relative` and paint above). It mounts only when the selection
           enters this week — the cross-week case, where the strip is paging
           anyway — and a mount-time transform doesn't transition, so the
           circle pops in at the right column instead of sliding from a stale
           one. The wrapper mirrors a cell's column structure (invisible
           weekday glyph, then the circle) so it lands exactly behind the
           number for any font metrics. */
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex w-[calc(100%/7)] flex-col items-center gap-0.5 py-1 transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(${selectedIndex * 100}%)` }}
        >
          <span aria-hidden className="invisible text-[11px] font-medium">
            M
          </span>
          <span className="size-8 animate-in rounded-full bg-primary duration-200 fade-in zoom-in-75 motion-reduce:animate-none" />
        </span>
      )}
      {days.map((day) => {
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
            className="relative flex flex-1 flex-col items-center gap-0.5 py-1"
          >
            <span className="text-[11px] font-medium text-text-muted">
              {format(parseIsoDate(day), 'EEEEE')}
            </span>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-full text-sm tabular-nums transition-colors duration-200',
                selected && 'font-semibold text-primary-foreground',
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
