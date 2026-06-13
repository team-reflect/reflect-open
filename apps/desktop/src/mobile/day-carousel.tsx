import { type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { dateAtIndex } from '@/lib/day-window'
import { useDayCarousel } from '@/mobile/use-day-carousel'

interface DayCarouselProps {
  /** The selected day (from the route). Drives the carousel position. */
  date: string
  /** Settle on a day — the parent turns this into a daily-route navigation. */
  onSelect: (date: string) => void
}

/** Slides within this many of the selection mount an editor; the rest are
 *  empty spacers Embla can still measure (bounds webview memory). */
const MOUNT_RADIUS = 1

/**
 * V1's swipeable day carousel: horizontal paging between daily notes. The slide
 * window, Embla wiring, and route↔slide sync all live in {@link useDayCarousel};
 * this component just renders the slides, mounting a `NotePane` only near the
 * selection and leaving the rest as empty spacers.
 */
export function DayCarousel({ date, onSelect }: DayCarouselProps): ReactElement {
  const { emblaRef, dayWindow, selectedIndex } = useDayCarousel(date, onSelect)

  return (
    <div className="min-h-0 flex-1 overflow-hidden" ref={emblaRef}>
      <div className="flex h-full">
        {Array.from({ length: dayWindow.count }, (_, index) => {
          const day = dateAtIndex(dayWindow, index)
          const mounted = Math.abs(index - selectedIndex) <= MOUNT_RADIUS
          return (
            <div key={day} className="min-w-0 flex-[0_0_100%]">
              {mounted ? (
                <div
                  className="h-full overflow-y-auto"
                  style={{
                    paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))',
                  }}
                >
                  <NotePane
                    path={dailyPath(day)}
                    lazy
                    gutterClassName="px-4"
                    editorClassName="min-h-[60dvh]"
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
