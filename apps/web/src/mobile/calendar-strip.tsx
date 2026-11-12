import { useEffect, useRef, type ReactElement } from 'react'
import { ChevronDown, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { addDaysToIsoDate, addMonthsToYearMonth, getYearMonth } from '@reflect/utils'
import { getUserWeekStart } from '@reflect/core'
import { formatMonthLabel, monthPickTarget, weekAtIndex } from '@reflect/app'
import { cn } from '@/lib/utils.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { MonthPicker, type MonthPickerHandle } from '@/mobile/month-picker.tsx'
import { MonthTitle } from '@/mobile/month-title.tsx'
import type { NativeMenuItem } from '@/mobile/native-chrome/protocol.ts'
import { useNativeBar } from '@/mobile/native-chrome/registrations.ts'
import { useDailyNoteDates } from '@/mobile/use-daily-note-dates.ts'
import { useWeekStrip } from '@/mobile/use-week-strip.ts'
import { WeekRow } from '@/mobile/week-row.tsx'
import { useWeekStartDay } from '@/providers/settings-provider.tsx'
import { useRouterActions } from '@/routing/router.tsx'

interface CalendarStripProps {
  /**
   * The day the strip should highlight — the route's selected day, or the
   * destination of an in-flight carousel swipe (the parent hands the swipe
   * target over mid-swipe so the strip and month title lead the route).
   */
  date: string
  /** Today's live ISO date — owned by the parent so the strip and the
   *  parent's select logic share one value (no midnight-rollover skew). */
  today: string
  /**
   * Bumped on an explicit re-arrival at the shown day (Daily tab tapped
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
 * the parent's `date`. Month changes roll through {@link MonthTitle} rather
 * than swapping. The month title is a {@link MonthPicker} to jump across
 * months, and a **Today** affordance appears in the header when
 * the selection has wandered off today.
 */
export function CalendarStrip({
  date,
  today,
  resetSeq,
  onSelect,
}: CalendarStripProps): ReactElement {
  const { haptics } = useMobileServices()
  const weekStartDay = useWeekStartDay()
  const { navigate } = useRouterActions()
  const { scrollerRef, weekWindow, displayedWeekStart, showWeekOf } = useWeekStrip(
    date,
    weekStartDay,
  )
  const dailyNoteDates = useDailyNoteDates(
    weekWindow.start,
    addDaysToIsoDate(weekAtIndex(weekWindow, weekWindow.count - 1), 6),
  )

  // Header month: the selection's own month while its week is on screen;
  // while browsing, the visible week's dominant (middle-day) month.
  const selectionWeekStart = getUserWeekStart(date, weekStartDay)
  const headerDate =
    displayedWeekStart === selectionWeekStart ? date : addDaysToIsoDate(displayedWeekStart, 3)
  const showToday = date !== today

  const jumpToToday = (): void => {
    hapticImpactLight(haptics)
    onSelect(today)
    // Selecting today only moves the strip when `date` changes — re-center
    // explicitly so a browse-away strip snaps back even when already on today.
    showWeekOf(today)
  }

  const openSettings = (): void => {
    hapticImpactLight(haptics)
    navigate({ kind: 'settings' })
  }

  const pickMonth = (picked: string): void => {
    const target = monthPickTarget(picked, date, today)
    onSelect(target)
    // Selecting the target only moves the strip when `date` changes — picking
    // the selection's own month must still snap a browsed-away strip back.
    showWeekOf(target)
  }

  const pickerRef = useRef<MonthPickerHandle | null>(null)
  const shownMonth = getYearMonth(headerDate)
  useNativeBar(
    {
      title: formatMonthLabel(shownMonth),
      titleMenu: recentMonthItems(getYearMonth(today), shownMonth),
      leading: [{ id: 'settings', title: 'Settings', icon: 'gearshape' }],
      trailing: showToday ? [{ id: 'today', title: 'Today' }] : [],
    },
    {
      onAction: (id) => {
        if (id === 'today') {
          jumpToToday()
        } else if (id === 'settings') {
          openSettings()
        } else if (id === 'monthPicker') {
          pickerRef.current?.open()
        } else if (id.startsWith('month:')) {
          pickMonth(id.slice('month:'.length))
        }
      },
    },
  )

  // An explicit re-arrival doesn't change `date`, so the follow effect won't
  // move a browsed-away strip — re-center it here.
  const lastResetSeqRef = useRef(resetSeq)
  useEffect(() => {
    if (resetSeq === lastResetSeqRef.current) {
      return
    }
    lastResetSeqRef.current = resetSeq
    showWeekOf(date)
  }, [resetSeq, date, showWeekOf])

  return (
    <header className="shrink-0 border-b border-border px-safe-offset-2 pt-safe pb-1">
      {/* Three equal-flanked columns so the month sits at the screen's center
          regardless of the gear (left) and the fading Today button (right). */}
      <div data-daily-header className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 px-1 py-1">
        <div className="justify-self-start">
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Settings"
            onClick={openSettings}
          >
            <Settings />
          </Button>
        </div>
        <h1 className="min-w-0 text-center text-base font-semibold">
          <MonthPicker
            ref={pickerRef}
            month={getYearMonth(headerDate)}
            selected={getYearMonth(date)}
            today={getYearMonth(today)}
            onPick={pickMonth}
          >
            <MonthTitle month={getYearMonth(headerDate)} />
            <ChevronDown aria-hidden className="size-4 shrink-0 text-text-muted" />
          </MonthPicker>
        </h1>
        <div className="justify-self-end">
          <Button
            variant="ghost"
            size="sm"
            aria-hidden={!showToday || undefined}
            inert={!showToday}
            className={cn(
              'transition-opacity duration-150 motion-reduce:transition-none',
              showToday ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
            onClick={jumpToToday}
          >
            Today
          </Button>
        </div>
      </div>
      <div ref={scrollerRef} data-scroll-x className="pager-x flex overflow-x-auto">
        {Array.from({ length: weekWindow.count }, (_, index) => {
          const weekStart = weekAtIndex(weekWindow, index)
          const weekEnd = addDaysToIsoDate(weekStart, 6)
          const contains = (day: string): boolean => day >= weekStart && day <= weekEnd
          return (
            <WeekRow
              key={weekStart}
              weekStart={weekStart}
              selectedDay={contains(date) ? date : null}
              todayDay={contains(today) ? today : null}
              dailyNoteDates={dailyNoteDates}
              onSelect={onSelect}
            />
          )
        })}
      </div>
    </header>
  )
}

/**
 * The month menu of the native Daily title: today's month and the five
 * before it, newest first, with a check on `shown` (added first when it is
 * not one of them), then the full picker.
 */
function recentMonthItems(todayMonth: string, shown: string): NativeMenuItem[] {
  const months = Array.from({ length: 6 }, (_, index) => addMonthsToYearMonth(todayMonth, -index))
  // A month outside the recent ones (a far date) still shows with its check.
  if (!months.includes(shown)) {
    months.unshift(shown)
  }
  return [
    ...months.map((month): NativeMenuItem => ({
      type: 'action',
      id: `month:${month}`,
      title: formatMonthLabel(month),
      checked: month === shown,
    })),
    {
      type: 'section',
      items: [{ type: 'action', id: 'monthPicker', title: 'Choose Month…', icon: 'calendar' }],
    },
  ]
}
