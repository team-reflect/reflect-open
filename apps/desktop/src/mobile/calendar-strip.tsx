import { useEffect, useRef, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { addDaysIso } from '@/lib/dates'
import { monthLabel, weekAtIndex, weekStartOf } from '@/mobile/calendar'
import { SettingsSheet } from '@/mobile/settings-sheet'
import { useWeekStrip } from '@/mobile/use-week-strip'
import { WeekRow } from '@/mobile/week-row'
import { useSettings } from '@/providers/settings-provider'

interface CalendarStripProps {
  /** The selected day (the centered carousel slide). */
  date: string
  /** Today's live ISO date — owned by the parent so the strip and the
   *  parent's select logic share one value (no midnight-rollover skew). */
  today: string
  /**
   * Bumped on an explicit re-arrival at the shown day (Daily tab / title tap
   * while already there): re-center the strip on the selection even though
   * `date` didn't change.
   */
  resetSeq: number
  /** Select a day — drives the carousel and the route. */
  onSelect: (date: string) => void
}

/**
 * V1's calendar strip: a month header over a **pageable** week row — seven
 * day-of-week / day-number cells per week, swipe left/right to browse whole
 * weeks, tap a cell to select that day. Browsing moves the header month with
 * the visible week; the strip snaps back to the selection's week whenever the
 * selection itself changes, so strip and carousel stay in lockstep through
 * the parent's `date`. The tappable month title jumps back to today (V1), and
 * a **Today** affordance appears in the header when the selection has
 * wandered off today.
 */
export function CalendarStrip({ date, today, resetSeq, onSelect }: CalendarStripProps): ReactElement {
  const { settings } = useSettings()
  const { emblaRef, weekWindow, displayedWeekStart, showWeekOf } = useWeekStrip(
    date,
    settings.weekStartDay,
  )

  // Header month: the selection's own month while its week is on screen;
  // while browsing, the visible week's dominant (middle-day) month.
  const selectionWeekStart = weekStartOf(date, settings.weekStartDay)
  const headerDate =
    displayedWeekStart === selectionWeekStart ? date : addDaysIso(displayedWeekStart, 3)

  const jumpToToday = (): void => {
    onSelect(today)
    // Selecting today only moves the strip when `date` changes — re-center
    // explicitly so a browse-away strip snaps back even when already on today.
    showWeekOf(today)
  }

  // An explicit re-arrival doesn't change `date`, so the follow effect won't
  // move a browsed-away strip — re-center it here.
  const lastResetSeq = useRef(resetSeq)
  useEffect(() => {
    if (resetSeq === lastResetSeq.current) {
      return
    }
    lastResetSeq.current = resetSeq
    showWeekOf(date)
  }, [resetSeq, date, showWeekOf])

  return (
    <header
      className="shrink-0 border-b border-border px-2 pb-1"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Three equal-flanked columns so the month sits at the screen's center
          regardless of the gear (left) and the conditional Today button (right). */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 px-1 py-1">
        <div className="justify-self-start">
          <SettingsSheet />
        </div>
        <h1 className="min-w-0 truncate text-center text-base font-semibold">
          <button type="button" aria-label="Jump to today" onClick={jumpToToday}>
            {monthLabel(headerDate)}
          </button>
        </h1>
        <div className="justify-self-end">
          {date !== today && (
            <Button variant="ghost" size="sm" onClick={jumpToToday}>
              Today
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex">
          {Array.from({ length: weekWindow.count }, (_, index) => {
            const weekStart = weekAtIndex(weekWindow, index)
            const weekEnd = addDaysIso(weekStart, 6)
            const contains = (day: string): boolean => day >= weekStart && day <= weekEnd
            return (
              <WeekRow
                key={weekStart}
                weekStart={weekStart}
                selectedDay={contains(date) ? date : null}
                todayDay={contains(today) ? today : null}
                onSelect={onSelect}
              />
            )
          })}
        </div>
      </div>
    </header>
  )
}
