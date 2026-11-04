import {
  startTransition,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { createDayWindow, dateAtIndex, indexWithin, type DayWindow } from '@reflect/app'
import { nearestIndex, restOn } from '@/lib/scroll-pager.ts'
import { watchScrollSettle, type ScrollSettleWatch } from '@/lib/scroll-settle.ts'

/**
 * Days either side of the carousel anchor. A fixed **symmetric** window
 * (three months each way) lets the carousel page between days without runtime
 * re-anchoring in ordinary use; only the days near the selection mount a
 * slide, so the rest are cheap empty cells. Swiping within
 * {@link RECENTER_MARGIN} of an edge (or a date-link beyond the window)
 * re-anchors it around the current day, so both directions stay effectively
 * infinite (V1 parity). The desktop daily stream shares the window math
 * ({@link createDayWindow}) with a wider, asymmetric reach — but it truly
 * virtualizes its rows, where the carousel renders every day cell and
 * only mounts the slides near the selection.
 *
 * The cells are cheap but not free: every cell is a DOM node and a snap
 * area, and a re-anchor re-renders and re-lays them all out — the home
 * screen's swipe cost scales linearly with this number (the iOS battery
 * audit's finding at the old ~1-year radius). 90 keeps 60 swipes of
 * headroom from center before a re-anchor at {@link RECENTER_MARGIN},
 * far beyond a realistic swipe burst, at a quarter of the belt.
 */
export const CAROUSEL_RADIUS = 90

/**
 * How close (in slides) a settled swipe may get to a window edge before the
 * window re-centers around the current day. Generous enough that a swipe
 * burst never lands on the hard edge between settles.
 */
export const RECENTER_MARGIN = 30

const CAROUSEL_WINDOW: Readonly<{ past: number; future: number }> = {
  past: CAROUSEL_RADIUS,
  future: CAROUSEL_RADIUS,
}

/**
 * True when `index` sits within `margin` slides of either edge of the window —
 * the signal to rebuild it centered on the current day. Pure for testing.
 */
export function shouldRecenter(
  window: DayWindow,
  index: number,
  margin: number = RECENTER_MARGIN,
): boolean {
  return index < margin || index >= window.count - margin
}

/** What the carousel should do when the external target `date` changes. */
export type CarouselSync =
  | { action: 'none' }
  | { action: 'reinit'; index: number }
  | { action: 'scroll'; index: number }

/** Inputs to {@link reconcileCarousel} — all plain values, no DOM. */
export interface ReconcileInput {
  /** Index of the target date in the current window, or `-1` if outside it. */
  index: number
  /** The current window's start date. */
  windowStart: string
  /** The window start the carousel was last reconciled against. */
  lastWindowStart: string
  /** The target date the carousel is being asked to show. */
  date: string
  /** The day last reported back through `onSelect` — the echo guard. */
  reported: string
  /** A date-preserving arrival must still cancel any in-flight swipe. */
  forceScroll: boolean
}

/**
 * Decide how the carousel should follow an external `date` change. Pure, so the
 * branchy reconciliation can be unit-tested without a scroller:
 *
 * - `none` when the date is outside the window (`index === -1`, a re-anchor is
 *   pending) or is the echo of our own swipe (already reported) — the carousel
 *   is already showing that slide, and the echo's redundant jump would clip an
 *   animation the user may have restarted.
 * - `reinit` when the window was re-anchored (its start moved): the scroller
 *   must move onto the rebuilt cells at the target index.
 * - `scroll` for an ordinary in-window jump (calendar tap, Today, near link),
 *   or a forced same-date arrival that must cancel an in-flight swipe.
 */
export function reconcileCarousel(input: ReconcileInput): CarouselSync {
  if (input.index === -1) {
    return { action: 'none' }
  }
  if (input.windowStart !== input.lastWindowStart) {
    return { action: 'reinit', index: input.index }
  }
  if (input.forceScroll) {
    return { action: 'scroll', index: input.index }
  }
  if (input.date === input.reported) {
    return { action: 'none' }
  }
  return { action: 'scroll', index: input.index }
}

export interface DayCarousel {
  /** Attach to the horizontal scroller. */
  scrollerRef: RefObject<HTMLDivElement | null>
  /** The current slide window (`count` is the cell total). */
  dayWindow: DayWindow
  /** The settled slide's index. */
  selectedIndex: number
  /** The first and last index (inclusive) that mount a slide. */
  mountedRange: { low: number; high: number }
}

/** Days either side of the selection and the swipe's reach that mount a slide. */
const MOUNT_RADIUS = 1

/**
 * The settled slide, and the nearest indexes (`low` to `high`) a swipe has
 * scrolled to since that settle.
 */
interface CarouselSelectionState {
  readonly navigationKey: string
  readonly index: number
  readonly low: number
  readonly high: number
}

/** The selection settled on `index`, with no swipe reach beyond it. */
function settledOn(navigationKey: string, index: number): CarouselSelectionState {
  return { navigationKey, index, low: index, high: index }
}

/**
 * State updater settling on the arrival's `navigationKey` and `index`, bailing
 * out (returning the current state) when it already is — the state is an
 * object, so an unconditional set would re-render the carousel even when
 * nothing changed.
 */
function adoptSelection(
  navigationKey: string,
  index: number,
): (current: CarouselSelectionState) => CarouselSelectionState {
  return (current) => {
    return current.navigationKey === navigationKey &&
      current.index === index &&
      current.low === index &&
      current.high === index
      ? current
      : settledOn(navigationKey, index)
  }
}

interface CarouselNavigationState {
  readonly navigationKey: string
  readonly date: string
}

/**
 * Drives the swipeable day carousel: owns the slide window, the native
 * scroller's position, and the bidirectional `date ↔ slide` sync, leaving
 * {@link DayCarousel} (the component) purely declarative.
 *
 * The browser moves the scroller with the finger and snaps it to a day, so the
 * gesture never waits for the main thread. Once a user scroll passes half a
 * page, the next day mounts and `onTarget` announces the nearest day (for
 * lightweight chrome — the calendar strip and its month title — to follow
 * the gesture). `onSelect` fires once the scroll settles (which the parent
 * turns into a daily-route navigation). The route flows back in as `date` and
 * moves the scroller to match — guarded by {@link reconcileCarousel} so the
 * swipe's own echo doesn't redundantly re-scroll. A `date` beyond the window
 * re-anchors it. Scrolls that no finger or wheel started (a caret
 * reveal, a focus) are pulled back to the selected day.
 */
export function useDayCarousel(
  date: string,
  navigationKey: string,
  onSelect: (date: string) => void,
  onTarget: (date: string, navigationKey: string) => void,
): DayCarousel {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [dayWindow, setDayWindow] = useState<DayWindow>(() => {
    return createDayWindow(date, CAROUSEL_WINDOW)
  })
  const routeIndex = indexWithin(dayWindow, date)
  const [selection, setSelection] = useState<CarouselSelectionState>(() => {
    return settledOn(navigationKey, routeIndex)
  })
  // A newer router arrival is authoritative over transition-priority swipe
  // state. Carry its identity in the state itself so an older queued updater
  // cannot restore the old mount range after navigation has won.
  const currentSelection =
    selection.navigationKey === navigationKey
      ? selection
      : settledOn(navigationKey, routeIndex === -1 ? selection.index : routeIndex)
  if (currentSelection !== selection) {
    setSelection(currentSelection)
  }
  const selectedIndex = currentSelection.index
  const mountedRange = {
    low: Math.max(0, currentSelection.low - MOUNT_RADIUS),
    high: Math.min(dayWindow.count - 1, currentSelection.high + MOUNT_RADIUS),
  }

  // The day we last reported via onSelect — so the route echo it produces
  // doesn't trigger a redundant (momentum-cancelling) scroll.
  const reportedRef = useRef(date)
  // The window start we last reconciled against — a change means a re-anchor.
  const windowStartRef = useRef(dayWindow.start)
  const reconciledNavigationRef = useRef<CarouselNavigationState>({ navigationKey, date })
  // The index the scroller rests on between gestures. Written before every
  // programmatic scroll, so the scroll events it causes find nothing to heal.
  const selectedIndexRef = useRef(routeIndex)
  // The nearest index the current user scroll has reached.
  const nearestRef = useRef(routeIndex)
  // A user scroll has moved the scroller and has not settled.
  const userScrollingRef = useRef(false)

  // Passing half a page is the earliest point the swipe's day is known
  // without predicting the snap: the next day mounts while the browser keeps
  // the gesture moving, and the strip follows. The reach only grows until
  // the settle, so dragging back and forth over the middle mounts nothing twice.
  // The strip update stays out of the mount's transition, so it does not wait
  // for the next day's editor to render.
  const handleScroll = useEffectEvent((scroller: HTMLElement, watch: ScrollSettleWatch) => {
    if (!watch.isUserScroll()) {
      restOn(scroller, selectedIndexRef.current)
      return
    }
    userScrollingRef.current = true
    const nearest = nearestIndex(scroller, dayWindow.count)
    if (nearest === undefined || nearest === nearestRef.current) {
      return
    }
    nearestRef.current = nearest
    onTarget(dateAtIndex(dayWindow, nearest), navigationKey)
    startTransition(() => {
      setSelection((current) => {
        return current.navigationKey === navigationKey
          ? {
              ...current,
              low: Math.min(current.low, nearest),
              high: Math.max(current.high, nearest),
            }
          : current
      })
    })
  })

  // The swipe's heavy consequence — reporting the day, which the parent turns
  // into a route navigation — waits for the settle. Settling near a window
  // edge also rebuilds the window around the current day; the report lands
  // in the same batch, so the follow effect sees the re-anchored window
  // together with the new `date` and moves the scroller onto the same day.
  const handleSettle = useEffectEvent((scroller: HTMLElement, watch: ScrollSettleWatch) => {
    userScrollingRef.current = false
    if (!watch.isUserScroll()) {
      restOn(scroller, selectedIndexRef.current)
      return
    }
    const index = nearestIndex(scroller, dayWindow.count)
    if (index === undefined) {
      return
    }
    selectedIndexRef.current = index
    nearestRef.current = index
    // WebKit can come to rest between snap points.
    restOn(scroller, index)
    const day = dateAtIndex(dayWindow, index)
    // An editor left focused on another day would scroll the carousel back to
    // reveal its caret.
    const active = document.activeElement
    const activeDay = active?.closest('[data-day]')?.getAttribute('data-day')
    if (active instanceof HTMLElement && activeDay && activeDay !== day) {
      active.blur()
    }
    setSelection(adoptSelection(navigationKey, index))
    if (day !== reportedRef.current) {
      reportedRef.current = day
      onSelect(day)
    }
    if (shouldRecenter(dayWindow, index)) {
      setDayWindow(createDayWindow(day, CAROUSEL_WINDOW))
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
      onSettle: () => handleSettle(scroller, watch),
      signal: controller.signal,
      dragHandle: null,
    })
    // After the watch, whose own listener decides whether this scroll is the user's.
    const onScroll = (): void => handleScroll(scroller, watch)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    // Rotation and split view change the page width: stay on the same day,
    // unless a finger or its momentum owns the position (the settle aligns it).
    const resize = new ResizeObserver(() => {
      if (!watch.isTouching() && !userScrollingRef.current) {
        restOn(scroller, selectedIndexRef.current)
      }
    })
    resize.observe(scroller)
    return () => {
      controller.abort()
      scroller.removeEventListener('scroll', onScroll)
      resize.disconnect()
    }
  }, [])

  // Re-anchor only when the requested day falls outside the window (a far date
  // link): rebuild the window centered on it. The follow effect below then
  // moves the scroller onto the new cells — so `reportedRef` is left
  // untouched here. Layout effect so the rebuilt window + scroll land in the
  // same frame as the strip's new selection (no visible lag).
  useLayoutEffect(() => {
    if (indexWithin(dayWindow, date) === -1) {
      // Re-anchor the window when a far date link lands outside it; runs only on
      // that rare miss, and the rebuilt window then contains the date, so it
      // cannot loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDayWindow(createDayWindow(date, CAROUSEL_WINDOW))
    }
  }, [date, dayWindow])

  // Places the scroller on the route's day before the first paint.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) {
      restOn(scroller, selectedIndexRef.current)
    }
  }, [])

  // Follow an external selection (calendar tap, Today, date link): jump, or
  // do nothing for our own swipe's echo — {@link reconcileCarousel} owns the
  // decision. A *layout* effect so the scroll and `selectedIndex` (which
  // decides slide mounting) update before paint. An instant scroll also
  // cancels any momentum still running.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    const previousNavigation = reconciledNavigationRef.current
    const forceScroll =
      previousNavigation.navigationKey !== navigationKey && previousNavigation.date === date
    reconciledNavigationRef.current = { navigationKey, date }
    const sync = reconcileCarousel({
      index: indexWithin(dayWindow, date),
      windowStart: dayWindow.start,
      lastWindowStart: windowStartRef.current,
      date,
      reported: reportedRef.current,
      forceScroll,
    })
    if (sync.action === 'none') {
      return
    }
    windowStartRef.current = dayWindow.start
    reportedRef.current = date
    selectedIndexRef.current = sync.index
    nearestRef.current = sync.index
    userScrollingRef.current = false
    restOn(scroller, sync.index)
    setSelection(adoptSelection(navigationKey, sync.index))
  }, [date, dayWindow, navigationKey])

  return { scrollerRef, dayWindow, selectedIndex, mountedRange }
}
