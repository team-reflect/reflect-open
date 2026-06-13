import { type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel } from '@/lib/dates'
import { dateAtIndex } from '@/lib/day-window'
import { cn } from '@/lib/utils'
import { useDayCarousel } from '@/mobile/use-day-carousel'
import { useSettings } from '@/providers/settings-provider'

interface DayCarouselProps {
  /** The selected day (from the route). Drives the carousel position. */
  date: string
  /** Today's live ISO date — tints today's date heading, as on desktop. */
  today: string
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
export function DayCarousel({ date, today, onSelect }: DayCarouselProps): ReactElement {
  const { emblaRef, dayWindow, selectedIndex } = useDayCarousel(date, onSelect)
  const { settings } = useSettings()

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
                  {/* The date is the daily note's subject (V1 / desktop parity) —
                      chrome above the editor, formatted per the user's setting,
                      tinted on today. Shares the note body's px-4 gutter. */}
                  <h2 className={cn('reflect-daily-subject px-4 pt-4 pb-1', day === today && 'text-accent')}>
                    {formatDayLabel(day, settings.dateFormat)}
                  </h2>
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
