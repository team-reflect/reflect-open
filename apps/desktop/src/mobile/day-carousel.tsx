import { useMemo, useState, type ReactElement } from 'react'
import { dateAtIndex } from '@reflect/app'
import { DaySlide } from '@/mobile/day-slide.tsx'
import { useKeyboardVisible } from '@/mobile/use-keyboard.ts'
import { useDayCarousel } from '@/mobile/use-day-carousel.ts'
import { cn } from '@/lib/utils.ts'

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
   * The day nearest the scroller during a swipe, announced as the swipe passes
   * half a page — for chrome (the calendar strip and its month title) that
   * should move with the gesture, ahead of the route. The key identifies the
   * source arrival so the receiver can reject stale updates.
   */
  onTarget: (date: string, navigationKey: string) => void
}

/**
 * V1's swipeable day carousel: horizontal paging between daily notes. The slide
 * window, scroller position, and route↔slide sync all live in
 * {@link useDayCarousel}; this component renders a native horizontal scroller
 * with one empty snap cell per day, and a {@link DaySlide} over each cell in
 * the mounted range. Each day's scroll offset
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
  const { scrollerRef, dayWindow, selectedIndex, mountedRange } = useDayCarousel(
    date,
    navigationKey,
    onSelect,
    onTarget,
  )
  // One mutable map for the carousel's life; the identity never changes, so
  // holding it in state (read during render) rather than a ref is safe.
  const [scrollMemory] = useState(() => new Map<string, number>())
  const keyboardVisible = useKeyboardVisible()
  const cells = useMemo(() => {
    return Array.from({ length: dayWindow.count }, (_, index) => (
      <div
        key={dateAtIndex(dayWindow, index)}
        className="h-full w-full shrink-0 snap-start snap-always"
      />
    ))
  }, [dayWindow])
  const mountedIndexes = Array.from(
    { length: mountedRange.high - mountedRange.low + 1 },
    (_, offset) => mountedRange.low + offset,
  )

  return (
    <div
      ref={scrollerRef}
      data-scroll-x
      className={cn(
        'pager-x min-h-0 flex-1',
        // No swiping between days while the software keyboard is up (V1
        // parity: horizontal drags would fight text selection and the caret).
        keyboardVisible ? 'overflow-x-hidden' : 'overflow-x-auto',
      )}
    >
      <div className="relative flex h-full">
        {cells}
        {mountedIndexes.map((index) => {
          const day = dateAtIndex(dayWindow, index)
          return (
            <div
              key={day}
              data-day={day}
              // Off-screen days stay out of the focus order and the accessibility tree.
              inert={index !== selectedIndex}
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
