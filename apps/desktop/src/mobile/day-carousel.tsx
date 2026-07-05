import { useState, type ReactElement } from 'react'
import { dateAtIndex } from '@/lib/day-window'
import { DaySlide } from '@/mobile/day-slide'
import { useDayCarousel } from '@/mobile/use-day-carousel'

interface DayCarouselProps {
  /** The selected day (from the route). Drives the carousel position. */
  date: string
  /** Today's live ISO date — tints today's date heading, as on desktop. */
  today: string
  /**
   * Bumped on an explicit re-arrival at the shown day (Daily tab / title tap
   * while already there): the selected slide re-anchors to the top.
   */
  scrollResetSeq: number
  /** The selected daily note that should receive editor focus, if any. */
  focusDate: string | null
  /** Called once the requested daily editor has focused. */
  onFocusConsumed: () => void
  /** Settle on a day — the parent turns this into a daily-route navigation. */
  onSelect: (date: string) => void
}

/** Slides within this many of the selection mount an editor; the rest are
 *  empty spacers Embla can still measure (bounds webview memory). */
const MOUNT_RADIUS = 1

/**
 * V1's swipeable day carousel: horizontal paging between daily notes. The slide
 * window, Embla wiring, and route↔slide sync all live in {@link useDayCarousel};
 * this component just renders the slides, mounting a {@link DaySlide} only near
 * the selection and leaving the rest as empty spacers. Each day's scroll offset
 * lives in a carousel-owned map so it survives its slide unmounting (V1's
 * per-slide scroll preservation).
 */
export function DayCarousel({
  date,
  today,
  scrollResetSeq,
  focusDate,
  onFocusConsumed,
  onSelect,
}: DayCarouselProps): ReactElement {
  const { emblaRef, dayWindow, selectedIndex } = useDayCarousel(date, onSelect)
  // One mutable map for the carousel's life; the identity never changes, so
  // holding it in state (read during render) rather than a ref is safe.
  const [scrollMemory] = useState(() => new Map<string, number>())

  return (
    <div className="min-h-0 flex-1 overflow-hidden" ref={emblaRef}>
      <div className="flex h-full">
        {Array.from({ length: dayWindow.count }, (_, index) => {
          const day = dateAtIndex(dayWindow, index)
          const mounted = Math.abs(index - selectedIndex) <= MOUNT_RADIUS
          return (
            <div key={day} className="min-w-0 flex-[0_0_100%]">
              {mounted ? (
                <DaySlide
                  day={day}
                  today={today}
                  selected={index === selectedIndex}
                  scrollMemory={scrollMemory}
                  scrollResetSeq={scrollResetSeq}
                  focusRequested={focusDate === day && index === selectedIndex}
                  onFocusConsumed={onFocusConsumed}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
