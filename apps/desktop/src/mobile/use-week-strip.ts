import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { WeekStartDay } from '@reflect/core'
import { createWeekWindow, weekAtIndex, weekIndexOf, type WeekWindow } from '@reflect/app'
import { nearestIndex, pageWidth, restOn } from '@/lib/scroll-pager.ts'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'
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
  const reducedMotion = usePrefersReducedMotion()
  const [weekWindow, setWeekWindow] = useState<WeekWindow>(() => {
    return createWeekWindow(date, weekStartDay)
  })
  const [displayedIndex, setDisplayedIndex] = useState(weekWindow.anchorIndex)
  // The displayed week, for the scroller's listeners between renders.
  const displayedIndexRef = useRef(weekWindow.anchorIndex)
  // The window start we last reconciled against — a change means a rebuild,
  // so the scroller must move onto the new slides at the anchor.
  const windowStartRef = useRef(weekWindow.start)
  // The `date` the strip last followed — browsing must not snap back to it.
  const followedDateRef = useRef(date)
  // A user scroll has moved the strip and has not settled.
  const userScrollingRef = useRef(false)

  const display = useCallback((index: number): void => {
    displayedIndexRef.current = index
    setDisplayedIndex(index)
  }, [])

  // Shows week `index` in the header at once, then scrolls the strip to it.
  const scrollToWeek = useCallback(
    (index: number): void => {
      display(index)
      const scroller = scrollerRef.current
      if (!scroller) {
        return
      }
      userScrollingRef.current = false
      scroller.scrollTo({
        left: index * pageWidth(scroller),
        behavior: reducedMotion ? 'instant' : 'smooth',
      })
    },
    [display, reducedMotion],
  )

  // The header follows the week nearest a finger or wheel scroll. A scroll
  // that no finger or wheel started already shows its target.
  const handleScroll = useEffectEvent((scroller: HTMLElement, isUserScroll: boolean) => {
    if (!isUserScroll) {
      return
    }
    userScrollingRef.current = true
    const nearest = nearestIndex(scroller, weekWindow.count)
    if (nearest !== undefined && nearest !== displayedIndexRef.current) {
      display(nearest)
    }
  })

  // Re-center the window when paging settles near an edge, keeping the
  // browsed week on screen (it becomes the rebuilt window's anchor). A scroll
  // that no finger or wheel started (a scroll to the selection, a page width
  // change) settles on the displayed week.
  const handleSettle = useEffectEvent((scroller: HTMLElement, isUserScroll: boolean) => {
    userScrollingRef.current = false
    if (!isUserScroll) {
      restOn(scroller, displayedIndexRef.current)
      return
    }
    const index = nearestIndex(scroller, weekWindow.count)
    if (index === undefined) {
      return
    }
    // WebKit can come to rest between snap points.
    restOn(scroller, index)
    display(index)
    if (shouldRecenterWeeks(weekWindow, index)) {
      setWeekWindow(createWeekWindow(weekAtIndex(weekWindow, index), weekStartDay))
    }
  })

  // A focused day in another week (keyboard Tab) shows that week, so the
  // settle of the focus scroll keeps it on screen.
  const handleFocus = useEffectEvent((scroller: HTMLElement, target: EventTarget | null) => {
    const index = [...scroller.children].findIndex(
      (row) => target instanceof Node && row.contains(target),
    )
    if (index !== -1 && index !== displayedIndexRef.current) {
      scrollToWeek(index)
    }
  })

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    const controller = new AbortController()
    const watch = watchScrollSettle({
      element: scroller,
      onSettle: () => handleSettle(scroller, watch.isUserScroll()),
      signal: controller.signal,
    })
    // After the watch, whose own listener decides whether this scroll is the user's.
    scroller.addEventListener('scroll', () => handleScroll(scroller, watch.isUserScroll()), {
      passive: true,
      signal: controller.signal,
    })
    scroller.addEventListener('focusin', (event) => handleFocus(scroller, event.target), {
      signal: controller.signal,
    })
    // Rotation and split view change the page width: stay on the same week,
    // unless a finger or its momentum owns the position (the settle aligns it).
    const resize = new ResizeObserver(() => {
      if (!watch.isTouching() && !userScrollingRef.current) {
        restOn(scroller, displayedIndexRef.current)
      }
    })
    resize.observe(scroller)
    return () => {
      controller.abort()
      resize.disconnect()
    }
  }, [])

  // Places the scroller on the anchor week before the first paint.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) {
      restOn(scroller, displayedIndexRef.current)
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
      displayedIndexRef.current = weekWindow.anchorIndex
      userScrollingRef.current = false
      const scroller = scrollerRef.current
      if (scroller) {
        restOn(scroller, weekWindow.anchorIndex)
      }
      setDisplayedIndex(weekWindow.anchorIndex)
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
    scrollToWeek(index)
  }, [date, weekWindow, weekStartDay, scrollToWeek])

  const showWeekOf = useCallback(
    (target: string) => {
      const index = weekIndexOf(weekWindow, target, weekStartDay)
      if (index === -1) {
        setWeekWindow(createWeekWindow(target, weekStartDay))
        return
      }
      scrollToWeek(index)
    },
    [weekWindow, weekStartDay, scrollToWeek],
  )

  return {
    scrollerRef,
    weekWindow,
    displayedWeekStart: weekAtIndex(weekWindow, displayedIndex),
    showWeekOf,
  }
}
