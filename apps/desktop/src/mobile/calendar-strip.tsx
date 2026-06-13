import { useMemo, type ReactElement } from 'react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { parseIsoDate } from '@/lib/dates'
import { monthLabel, weekOf } from '@/mobile/calendar'
import { SettingsSheet } from '@/mobile/settings-sheet'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'

interface CalendarStripProps {
  /** The selected day (the centered carousel slide). */
  date: string
  /** Today's live ISO date — owned by the parent so the strip and the
   *  parent's select logic share one value (no midnight-rollover skew). */
  today: string
  /** Select a day — drives the carousel and the route. */
  onSelect: (date: string) => void
}

/**
 * V1's calendar strip: a month header and the selected day's week as seven
 * day-of-week / day-number cells, the selected day circled. Tapping a cell
 * selects that day; the week shown always contains the selection, so the
 * strip and the carousel stay in lockstep through the parent's `date`. A
 * **Today** affordance appears in the header when the selection has wandered.
 */
export function CalendarStrip({ date, today, onSelect }: CalendarStripProps): ReactElement {
  const { settings } = useSettings()
  const week = useMemo(() => weekOf(date, settings.weekStartDay), [date, settings.weekStartDay])

  return (
    <header
      className="shrink-0 border-b border-border px-2 pb-1"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-1 px-1 py-1">
        <SettingsSheet />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{monthLabel(date)}</h1>
        {date !== today && (
          <Button variant="ghost" size="sm" onClick={() => onSelect(today)}>
            Today
          </Button>
        )}
      </div>
      <div className="flex">
        {week.map((day) => {
          const selected = day === date
          const isToday = day === today
          return (
            <button
              key={day}
              type="button"
              aria-label={format(parseIsoDate(day), 'EEEE, MMMM do')}
              aria-current={selected ? 'date' : undefined}
              onClick={() => onSelect(day)}
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
    </header>
  )
}
