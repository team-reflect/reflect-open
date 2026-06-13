import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { carouselDateAt, carouselIndexOf, carouselWindow, type CarouselWindow } from '@/mobile/calendar'

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
 * V1's swipeable day carousel: horizontal paging between daily notes over a
 * generous fixed window (≈1 year each way — no runtime re-anchoring). Each
 * settled slide navigates its day; the route flows back in as `date` and
 * scrolls the carousel to match (guarded so a swipe's own navigation doesn't
 * re-scroll). A date-link beyond the window re-anchors the window around it
 * — the rare case, never the common swipe.
 */
export function DayCarousel({ date, onSelect }: DayCarouselProps): ReactElement {
  const [window, setWindow] = useState<CarouselWindow>(() => carouselWindow(date))
  const [emblaRef, emblaApi] = useEmblaCarousel({
    startIndex: carouselIndexOf(window, date),
    align: 'center',
    skipSnaps: false,
  })
  const [selectedIndex, setSelectedIndex] = useState(() => carouselIndexOf(window, date))
  // The day we last reported via onSelect — so the route echo it produces
  // doesn't trigger a redundant (animation-cancelling) scrollTo.
  const reportedRef = useRef(date)

  const onEmblaSelect = useCallback(
    (api: NonNullable<typeof emblaApi>) => {
      const index = api.selectedScrollSnap()
      setSelectedIndex(index)
      const day = carouselDateAt(window, index)
      if (day !== reportedRef.current) {
        reportedRef.current = day
        onSelect(day)
      }
    },
    [window, onSelect],
  )

  useEffect(() => {
    if (!emblaApi) {
      return
    }
    emblaApi.on('select', onEmblaSelect)
    return () => {
      emblaApi.off('select', onEmblaSelect)
    }
  }, [emblaApi, onEmblaSelect])

  // Re-anchor only when the requested day falls outside the window (a far
  // date link). Rebuilding the window remounts Embla at the new start index.
  useEffect(() => {
    if (carouselIndexOf(window, date) === -1) {
      reportedRef.current = date
      setWindow(carouselWindow(date))
    }
  }, [date, window])

  // Follow an external selection (calendar strip tap, Today, date link) by
  // scrolling to its slide — skipped when this is the echo of our own swipe.
  useEffect(() => {
    if (!emblaApi || date === reportedRef.current) {
      return
    }
    const index = carouselIndexOf(window, date)
    if (index !== -1) {
      reportedRef.current = date
      emblaApi.scrollTo(index, true)
      setSelectedIndex(index)
    }
  }, [emblaApi, date, window])

  return (
    <div className="min-h-0 flex-1 overflow-hidden" ref={emblaRef}>
      <div className="flex h-full">
        {Array.from({ length: window.count }, (_, index) => {
          const day = carouselDateAt(window, index)
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
