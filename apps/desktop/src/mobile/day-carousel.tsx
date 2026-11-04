import { useMemo, useState, type ReactElement } from 'react'
import { dateAtIndex } from '@reflect/app'
import { DaySlide } from '@/mobile/day-slide.tsx'
import { useDayCarousel } from '@/mobile/use-day-carousel.ts'

interface DayCarouselProps {
  /** The selected day (from the route). Drives the carousel position. */
  date: string
  /** Identity of the route arrival that owns the selected day. */
  navigationKey: string
  /** Today's live ISO date — tints today's date heading, as on desktop. */
  today: string
  /**
   * Bumped on an explicit re-arrival at the shown day (Daily tab / Today tap
   * while already there): the selected slide re-anchors to the top.
   */
  scrollResetSeq: number
  /** The selected daily note that should receive editor focus, if any. */
  focusDate: string | null
  /** Called once the requested daily editor has focused. */
  onFocusConsumed: () => void
  /** Settle on a day — the parent turns this into a daily-route navigation. */
  onSelect: (date: string) => void
  /**
   * A swipe's destination day, announced at pointer-up while the snap
   * animation still plays — for chrome (the calendar strip and its month
   * title) that should move with the gesture, ahead of the route. The key
   * identifies the source arrival so the receiver can reject stale updates.
   */
  onTarget: (date: string, navigationKey: string) => void
}

/** Days within this many of the selection mount a slide (bounds webview memory). */
const MOUNT_RADIUS = 1

/**
 * V1's swipeable day carousel: horizontal paging between daily notes. The slide
 * window, Embla wiring, and route↔slide sync all live in {@link useDayCarousel};
 * this component renders one empty cell per day for Embla to snap to, and a
 * {@link DaySlide} over each cell near the selection. Each day's scroll offset
 * lives in a carousel-owned map so it survives its slide unmounting (V1's
 * per-slide scroll preservation).
 */
export function DayCarousel({
  date,
  navigationKey,
  today,
  scrollResetSeq,
  focusDate,
  onFocusConsumed,
  onSelect,
  onTarget,
}: DayCarouselProps): ReactElement {
  const { emblaRef, dayWindow, selectedIndex } = useDayCarousel(
    date,
    navigationKey,
    onSelect,
    onTarget,
  )
  // One mutable map for the carousel's life; the identity never changes, so
  // holding it in state (read during render) rather than a ref is safe.
  const [scrollMemory] = useState(() => new Map<string, number>())
  const cells = useMemo(() => {
    return Array.from({ length: dayWindow.count }, (_, index) => (
      <div key={dateAtIndex(dayWindow, index)} data-day-cell className="h-full w-full shrink-0" />
    ))
  }, [dayWindow])
  const mountedIndexes = useMemo(() => {
    const indexes: number[] = []
    for (
      let index = Math.max(0, selectedIndex - MOUNT_RADIUS);
      index <= Math.min(dayWindow.count - 1, selectedIndex + MOUNT_RADIUS);
      index++
    ) {
      indexes.push(index)
    }
    return indexes
  }, [selectedIndex, dayWindow.count])

  return (
    /* `overflow: clip`: not a scroll container, so a stray scrollLeft write
       (ProseMirror's caret reveal) cannot offset the transform-positioned
       belt. Inline so pre-iOS-16 falls back to the class's `hidden`, healed
       by the scroll guard in useDayCarousel. */
    <div className="min-h-0 flex-1 overflow-hidden" style={{ overflow: 'clip' }} ref={emblaRef}>
      <div className="relative flex h-full">
        {cells}
        {mountedIndexes.map((index) => {
          const day = dateAtIndex(dayWindow, index)
          return (
            <div
              key={day}
              data-day={day}
              className="absolute inset-y-0 w-full"
              style={{ left: `${index * 100}%` }}
            >
              <DaySlide
                day={day}
                today={today}
                selected={index === selectedIndex}
                scrollMemory={scrollMemory}
                scrollResetSeq={scrollResetSeq}
                focusRequested={focusDate === day && index === selectedIndex}
                onFocusConsumed={onFocusConsumed}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
