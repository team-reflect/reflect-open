import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { WeekStartDay } from '@reflect/core'
import { createWeekWindow, weekAtIndex, weekIndexOf, type WeekWindow } from '@reflect/app'
import { attachSnapPager, type SnapPager } from '@/lib/snap-pager.ts'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion.ts'

/**
 * How close (in weeks) a settled page may get to a window edge before the
 * window re-centers around the displayed week.
 */
export const WEEK_RECENTER_MARGIN = 3

/**
 * True when `index` sits within `margin` weeks of either window edge — the
 * signal to rebuild the window centered on the displayed week. Pure for
 * testing.
 */
export function shouldRecenterWeeks(
  window: WeekWindow,
  index: number,
  margin: number = WEEK_RECENTER_MARGIN,
): boolean {
  return index < margin || index >= window.count - margin
}

export interface WeekStrip {
  /** Attach to the strip's horizontal scroller. */
  scrollerRef: RefObject<HTMLDivElement | null>
  /** The current window of week slides. */
  weekWindow: WeekWindow
  /** Week-start of the visible (possibly browsed-to) week — the month header. */
  displayedWeekStart: string
  /**
   * Bring `target`'s week into view. For arrivals that don't change the
   * selected `date` (Today / title taps while already on today, tab
   * re-arrivals) — a changed `date` re-centers the strip by itself.
   */
  showWeekOf: (target: string) => void
}

/**
 * Drives the calendar strip's week paging (V1 parity): a native horizontal
 * scroller that snaps to one week slide at a time, over a re-centering
 * {@link WeekWindow}. Paging **browses** — it moves the visible week (and the
 * month header) without changing the selection; tapping a day navigates, and
 * the strip scrolls back to the selected `date` whenever it changes (a carousel
 * swipe, a date link, Today).
 *
 * The browser moves the strip with the finger and snaps it, so the gesture
 * never waits for the main thread. The month header follows the week nearest
 * a user scroll; a scroll to the selection shows its target week at once.
 *
 * Window rebuilds — a far `date` jump, a week-start setting change, or paging
 * near an edge — always land the rebuilt window's **anchor** week on screen:
 * every rebuild centers the window on the week it needs to show, so the
 * follow effect moves the scroller onto the anchor index uniformly.
 */
export function useWeekStrip(date: string, weekStartDay: WeekStartDay): WeekStrip {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<SnapPager | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const [weekWindow, setWeekWindow] = useState<WeekWindow>(() => {
    return createWeekWindow(date, weekStartDay)
  })
  const [displayedIndex, setDisplayedIndex] = useState(weekWindow.anchorIndex)
  // The window start we last reconciled against — a change means a rebuild,
  // so the scroller must move onto the new slides at the anchor.
  const windowStartRef = useRef(weekWindow.start)
  // The `date` the strip last followed — browsing must not snap back to it.
  const followedDateRef = useRef(date)

  const count = useEffectEvent(() => weekWindow.count)
  const shownIndex = useEffectEvent(() => displayedIndex)
  const prefersReducedMotion = useEffectEvent(() => reducedMotion)

  // Re-center the window when paging settles near an edge, keeping the
  // browsed week on screen (it becomes the rebuilt window's anchor).
  const handleSettle = useEffectEvent((index: number) => {
    if (shouldRecenterWeeks(weekWindow, index)) {
      setWeekWindow(createWeekWindow(weekAtIndex(weekWindow, index), weekStartDay))
    }
  })

  // Attaches the pager, which rests on the anchor week before the first paint.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    const controller = new AbortController()
    pagerRef.current = attachSnapPager({
      element: scroller,
      index: shownIndex(),
      count,
      prefersReducedMotion,
      onIndex: setDisplayedIndex,
      onSettle: handleSettle,
      signal: controller.signal,
    })
    return () => {
      pagerRef.current = null
      controller.abort()
    }
  }, [])

  // A week-start change re-aligns every week: rebuild around the selection.
  const weekStartDayRef = useRef(weekStartDay)
  useLayoutEffect(() => {
    if (weekStartDayRef.current === weekStartDay) {
      return
    }
    weekStartDayRef.current = weekStartDay
    setWeekWindow(createWeekWindow(date, weekStartDay))
  }, [weekStartDay, date])

  // Follow the selection and finish rebuilds. Layout effect so the strip's
  // position lands in the same frame as the day carousel's (no visible lag).
  useLayoutEffect(() => {
    if (weekWindow.start !== windowStartRef.current) {
      // Any rebuild centers the window on the week to show — land on it.
      windowStartRef.current = weekWindow.start
      followedDateRef.current = date
      pagerRef.current?.restOn(weekWindow.anchorIndex)
      return
    }
    if (followedDateRef.current === date) {
      return
    }
    followedDateRef.current = date
    const index = weekIndexOf(weekWindow, date, weekStartDay)
    if (index === -1) {
      // A far jump: rebuild around the new date; the branch above lands on
      // it. Runs only on that rare miss, and the rebuilt window contains the
      // date, so it cannot loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWeekWindow(createWeekWindow(date, weekStartDay))
      return
    }
    pagerRef.current?.show(index)
  }, [date, weekWindow, weekStartDay])

  const showWeekOf = useCallback(
    (target: string) => {
      const index = weekIndexOf(weekWindow, target, weekStartDay)
      if (index === -1) {
        setWeekWindow(createWeekWindow(target, weekStartDay))
        return
      }
      pagerRef.current?.show(index)
    },
    [weekWindow, weekStartDay],
  )

  return {
    scrollerRef,
    weekWindow,
    displayedWeekStart: weekAtIndex(weekWindow, displayedIndex),
    showWeekOf,
  }
}
