import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import { createDayWindow, dateAtIndex, indexWithin, type DayWindow } from '@/lib/day-window'
import { driftLog, reportSelectedDay } from '@/mobile/drift-probe'
import { getKeyboardHeight } from '@/mobile/use-keyboard'

/**
 * Days either side of the carousel anchor. A generous fixed **symmetric**
 * window (~1 year each way) lets Embla page between days without runtime
 * re-anchoring in ordinary use; only the slides near the selection mount an
 * editor, so the empty ones are cheap spacers. Swiping within
 * {@link RECENTER_MARGIN} of an edge (or a date-link beyond the window)
 * re-anchors it around the current day, so both directions stay effectively
 * infinite (V1 parity). The desktop daily stream shares the window math
 * ({@link createDayWindow}) with a wider, asymmetric reach — but it truly
 * virtualizes its rows, where the carousel renders every slide spacer and
 * only mounts the editors near the selection.
 */
export const CAROUSEL_RADIUS = 366

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

/**
 * Embla's `watchDrag` predicate: swiping between days is disabled while the
 * software keyboard is up (V1 parity — horizontal drags would fight text
 * selection and the caret). Module-level so the options object stays stable
 * across renders; Embla evaluates it at drag start.
 */
function dragAllowedWithKeyboardClosed(): boolean {
  const allowed = getKeyboardHeight() === 0
  driftLog('embla watchDrag evaluated', { keyboardHeight: getKeyboardHeight(), allowed })
  return allowed
}

/** What the carousel should do when the external target `date` changes. */
export type CarouselSync =
  | { action: 'none' }
  | { action: 'reinit'; index: number }
  | { action: 'scroll'; index: number }

/** Inputs to {@link reconcileCarousel} — all plain values, no Embla handle. */
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
}

/**
 * Decide how the carousel should follow an external `date` change. Pure, so the
 * branchy reconciliation can be unit-tested without driving Embla:
 *
 * - `none` when the date is outside the window (`index === -1`, a re-anchor is
 *   pending) or is the echo of our own swipe (already reported) — the carousel
 *   is already showing that slide, and the echo's redundant jump would clip an
 *   animation the user may have restarted.
 * - `reinit` when the window was re-anchored (its start moved): Embla must
 *   reinitialize onto the rebuilt slide set at the target index.
 * - `scroll` for an ordinary in-window jump (calendar tap, Today, near link).
 */
export function reconcileCarousel(input: ReconcileInput): CarouselSync {
  if (input.index === -1) {
    return { action: 'none' }
  }
  if (input.windowStart !== input.lastWindowStart) {
    return { action: 'reinit', index: input.index }
  }
  if (input.date === input.reported) {
    return { action: 'none' }
  }
  return { action: 'scroll', index: input.index }
}

export interface DayCarousel {
  /** Attach to the Embla viewport element. */
  emblaRef: ReturnType<typeof useEmblaCarousel>[0]
  /** The current slide window (`count` is the slide total). */
  dayWindow: DayWindow
  /** The centered slide's index — the view mounts editors around it. */
  selectedIndex: number
}

/**
 * Drives the swipeable day carousel: owns the slide window, the Embla instance,
 * and the bidirectional `date ↔ slide` sync, leaving {@link DayCarousel} (the
 * component) purely declarative.
 *
 * A swipe's destination is announced twice: `onTarget` fires at pointer-up
 * with the day the swipe will land on (for lightweight chrome — the calendar
 * strip and its month title — to follow while the snap animation plays), and
 * `onSelect` fires once the swipe settles (which the parent turns into a
 * daily-route navigation). The route flows back in as `date` and scrolls the
 * carousel to match — guarded by {@link reconcileCarousel} so the swipe's own
 * echo doesn't redundantly re-scroll. A `date` beyond the window re-anchors it,
 * and the follow effect then reinitializes Embla onto the new slides.
 */
export function useDayCarousel(
  date: string,
  onSelect: (date: string) => void,
  onTarget: (date: string) => void,
): DayCarousel {
  const [dayWindow, setDayWindow] = useState<DayWindow>(() => createDayWindow(date, CAROUSEL_WINDOW))
  // Frozen at mount: `embla-carousel-react` reinitializes whenever the options
  // object stops comparing equal, and `reInit` snaps to `startIndex` with no
  // animation — a render-derived `startIndex` would let every swipe's route
  // echo cancel the settle animation and hard-switch to the landed slide.
  // After mount, positioning belongs exclusively to the follow effect below.
  const [emblaOptions] = useState<Parameters<typeof useEmblaCarousel>[0]>(() => ({
    startIndex: indexWithin(dayWindow, date),
    align: 'center',
    skipSnaps: false,
    watchDrag: dragAllowedWithKeyboardClosed,
  }))
  const [emblaRef, emblaApi] = useEmblaCarousel(emblaOptions)
  const [selectedIndex, setSelectedIndex] = useState(() => indexWithin(dayWindow, date))
  // The day we last reported via onSelect — so the route echo it produces
  // doesn't trigger a redundant (animation-cancelling) scrollTo.
  const reportedRef = useRef(date)
  // The window start we last reconciled against — a change means a re-anchor,
  // so Embla must reinitialize rather than scroll.
  const windowStartRef = useRef(dayWindow.start)

  // The swipe's target is known at pointer-up (`select`), and two light
  // things follow it from there. The slide window: the mount radius tracks
  // `selectedIndex`, and a second swipe started mid-animation must land on a
  // mounted slide, not a blank spacer (the quick double-swipe). And
  // `onTarget`: the calendar strip — month title included — moves with the
  // gesture rather than after it. Both inside a transition, so React fits
  // the work around the snap animation's frames instead of blocking its
  // first ones.
  const onEmblaSelect = useCallback(
    (api: NonNullable<typeof emblaApi>) => {
      const index = api.selectedScrollSnap()
      driftLog('embla select', {
        index,
        day: dateAtIndex(dayWindow, index),
        // Optional-called: the unit tests' fake Embla api has no rootNode.
        viewportScrollLeft: api.rootNode?.().scrollLeft,
      })
      startTransition(() => {
        setSelectedIndex(index)
        onTarget(dateAtIndex(dayWindow, index))
      })
    },
    [dayWindow, onTarget],
  )

  // The swipe's heavy consequence — reporting the day, which the parent turns
  // into a route navigation re-rendering the whole surface — waits for
  // `settle` (snap animation done). Embla's fixed-timestep animation loop has
  // no lag cap, so paying that cost in the release frame would fast-forward
  // the physics to the target: the note would switch instantly instead of
  // sliding over.
  //
  // Settling near a window edge also rebuilds the window around the current
  // day, keeping swiping effectively infinite in both directions. The report
  // above lands in the same batch, so the follow effect below sees the
  // re-anchored window together with the new `date` and reinitializes Embla
  // onto the slide the user is already looking at.
  const onEmblaSettle = useCallback(
    (api: NonNullable<typeof emblaApi>) => {
      const index = api.selectedScrollSnap()
      driftLog('embla settle', {
        index,
        day: dateAtIndex(dayWindow, index),
        // Optional-called: the unit tests' fake Embla api has no rootNode.
        viewportScrollLeft: api.rootNode?.().scrollLeft,
      })
      setSelectedIndex(index)
      const day = dateAtIndex(dayWindow, index)
      if (day !== reportedRef.current) {
        reportedRef.current = day
        onSelect(day)
      }
      if (shouldRecenter(dayWindow, index)) {
        setDayWindow(createDayWindow(day, CAROUSEL_WINDOW))
      }
    },
    [dayWindow, onSelect],
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

  // Embla positions the slide belt with transforms and never reads or resets
  // the viewport's scrollLeft, but the viewport is an `overflow: hidden` box
  // with ~733 slides of scrollable overflow: any programmatic scrollLeft
  // write sticks as a permanent visual offset on every later snap.
  // ProseMirror's caret reveal is such a writer — scrollRectIntoView walks
  // every ancestor, and revealing a caret while a snap animation is mid-
  // flight writes the animation's residual displacement here (observed on
  // device; a negative residual clamps at 0, a positive one sticks). The
  // viewport's `overflow: clip` blocks writes on iOS 16+; this guard heals
  // the `overflow: hidden` fallback below that, and any native (UA) writer
  // clip can't intercept. Embla itself never scrolls the viewport, so any
  // scroll event here is a stray write.
  useEffect(() => {
    if (!emblaApi) {
      return
    }
    const viewport = emblaApi.rootNode()
    const reset = (): void => {
      if (viewport.scrollLeft !== 0) {
        viewport.scrollLeft = 0
      }
    }
    reset()
    viewport.addEventListener('scroll', reset, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', reset)
    }
  }, [emblaApi])

  // Re-anchor only when the requested day falls outside the window (a far date
  // link): rebuild the window centered on it. The follow effect below then
  // reinitializes Embla onto the new slides — so `reportedRef` is left
  // untouched here. Layout effect so the rebuilt window + scroll land in the
  // same frame as the strip's new selection (no visible lag).
  useLayoutEffect(() => {
    if (indexWithin(dayWindow, date) === -1) {
      driftLog('carousel re-anchor (date outside window)', { date, windowStart: dayWindow.start })
      // Re-anchor the window when a far date link lands outside it; runs only on
      // that rare miss, and the rebuilt window then contains the date, so it
      // cannot loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDayWindow(createDayWindow(date, CAROUSEL_WINDOW))
    }
  }, [date, dayWindow])

  // Follow an external selection (calendar tap, Today, date link): scroll, or
  // reinit after a re-anchor, or do nothing for our own swipe's echo —
  // {@link reconcileCarousel} owns the decision. A *layout* effect so Embla's
  // scroll and `selectedIndex` (which decides slide mounting) update before
  // paint — otherwise the centered/mounted slide lags the route by a frame and
  // the strip could show one day while the editor still shows the previous.
  useLayoutEffect(() => {
    if (!emblaApi) {
      return
    }
    const sync = reconcileCarousel({
      index: indexWithin(dayWindow, date),
      windowStart: dayWindow.start,
      lastWindowStart: windowStartRef.current,
      date,
      reported: reportedRef.current,
    })
    if (sync.action === 'none') {
      return
    }
    windowStartRef.current = dayWindow.start
    reportedRef.current = date
    // Optional-called: the unit tests' fake Embla api has no rootNode.
    const scrollLeftBefore = emblaApi.rootNode?.().scrollLeft
    if (sync.action === 'reinit') {
      emblaApi.reInit({ startIndex: sync.index })
    } else {
      emblaApi.scrollTo(sync.index, true)
    }
    driftLog('carousel follow effect', {
      action: sync.action,
      index: sync.index,
      date,
      viewportScrollLeft: `${scrollLeftBefore} -> ${emblaApi.rootNode?.().scrollLeft}`,
    })
    setSelectedIndex(sync.index)
  }, [emblaApi, date, dayWindow])

  // TEMPORARY drift debugging: tell the probe which day the carousel centers,
  // so reveal logs can compare it against the focused editor's day.
  useEffect(() => {
    reportSelectedDay(dateAtIndex(dayWindow, selectedIndex))
  }, [dayWindow, selectedIndex])

  return { emblaRef, dayWindow, selectedIndex }
}
