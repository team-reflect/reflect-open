import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import type { WeekStartDay } from '@reflect/core'
import {
  createWeekWindow,
  weekAtIndex,
  weekIndexOf,
  type WeekWindow,
} from '@/mobile/calendar'

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
  /** Attach to the strip's Embla viewport element. */
  emblaRef: ReturnType<typeof useEmblaCarousel>[0]
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
 * Drives the calendar strip's week paging (V1 parity): an Embla carousel of
 * week slides over a re-centering {@link WeekWindow}. Paging **browses** —
 * it moves the visible week (and the month header) without changing the
 * selection; tapping a day navigates, and the strip follows the selected
 * `date` back whenever it changes (a carousel swipe, a date link, Today).
 *
 * Window rebuilds — a far `date` jump, a week-start setting change, or paging
 * near an edge — always land the rebuilt window's **anchor** week on screen:
 * every rebuild centers the window on the week it needs to show, so the
 * follow effect reinitializes Embla onto the anchor index uniformly.
 */
export function useWeekStrip(date: string, weekStartDay: WeekStartDay): WeekStrip {
  const [weekWindow, setWeekWindow] = useState<WeekWindow>(() =>
    createWeekWindow(date, weekStartDay),
  )
  const [emblaRef, emblaApi] = useEmblaCarousel({ startIndex: weekWindow.anchorIndex })
  const [displayedIndex, setDisplayedIndex] = useState(weekWindow.anchorIndex)
  // The window start we last reconciled against — a change means a rebuild,
  // so Embla must reinitialize onto the new slides at the anchor.
  const windowStartRef = useRef(weekWindow.start)
  // The `date` the strip last followed — browsing must not snap back to it.
  const followedDateRef = useRef(date)

  const onEmblaSelect = useCallback((api: NonNullable<typeof emblaApi>) => {
    setDisplayedIndex(api.selectedScrollSnap())
  }, [])

  // Re-center the window when paging settles near an edge, keeping the
  // browsed week on screen (it becomes the rebuilt window's anchor).
  const onEmblaSettle = useCallback(
    (api: NonNullable<typeof emblaApi>) => {
      const index = api.selectedScrollSnap()
      if (shouldRecenterWeeks(weekWindow, index)) {
        setWeekWindow(createWeekWindow(weekAtIndex(weekWindow, index), weekStartDay))
      }
    },
    [weekWindow, weekStartDay],
  )

  useEffect(() => {
    if (!emblaApi) {
      return
    }
    emblaApi.on('select', onEmblaSelect)
    emblaApi.on('settle', onEmblaSettle)
    return () => {
      emblaApi.off('select', onEmblaSelect)
      emblaApi.off('settle', onEmblaSettle)
    }
  }, [emblaApi, onEmblaSelect, onEmblaSettle])

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
    if (!emblaApi) {
      return
    }
    if (weekWindow.start !== windowStartRef.current) {
      // Any rebuild centers the window on the week to show — land on it.
      windowStartRef.current = weekWindow.start
      followedDateRef.current = date
      emblaApi.reInit({ startIndex: weekWindow.anchorIndex })
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
    emblaApi.scrollTo(index)
    setDisplayedIndex(index)
  }, [emblaApi, date, weekWindow, weekStartDay])

  const showWeekOf = useCallback(
    (target: string) => {
      const index = weekIndexOf(weekWindow, target, weekStartDay)
      if (index === -1) {
        setWeekWindow(createWeekWindow(target, weekStartDay))
        return
      }
      emblaApi?.scrollTo(index)
      setDisplayedIndex(index)
    },
    [emblaApi, weekWindow, weekStartDay],
  )

  return {
    emblaRef,
    weekWindow,
    displayedWeekStart: weekAtIndex(weekWindow, displayedIndex),
    showWeekOf,
  }
}
