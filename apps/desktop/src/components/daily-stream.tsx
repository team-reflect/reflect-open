import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { createDayWindow, dateAtIndex, indexOfDate } from '@/lib/day-window'
import { useRouter } from '@/routing/router'

interface DailyStreamProps {
  /** The day to anchor/scroll to (from the `today` or `daily/:date` route). */
  targetDate: string
}

/**
 * The daily stream (Plan 06b): a virtualized chronological run of days — past
 * above, future below — where **every day is a virtual note**. Each visible row
 * mounts the Plan 05 editor lazily (`createIfMissing`), so a day only becomes a
 * real `daily/*.md` when edited. Offscreen rows unmount and flush through the
 * save pipeline's final-flush path. The window is a fixed ±range around today
 * (virtual rows are free), so there is no bidirectional infinite-scroll
 * bookkeeping; index↔date is pure offset math.
 */
export function DailyStream({ targetDate }: DailyStreamProps): ReactElement {
  const { arrivalSeq, entryId, saveScrollState, savedScroll } = useRouter()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // The window anchors at today-on-mount and stays stable for the view's life.
  const [window] = useState(() => createDayWindow(todayIso()))
  const today = todayIso()

  const virtualizer = useVirtualizer({
    count: window.count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    overscan: 2,
    paddingEnd: 240,
  })

  // Only the day navigated to receives focus, once per navigation — a row that
  // scrolls offscreen and back must not steal focus from wherever the user is.
  // The flag is consumed when the editor actually mounts and focuses (not at
  // render time), so a virtualizer re-render before the lazy load completes
  // can't drop the focus.
  const focusPending = useRef<string | null>(null)
  const consumeFocus = useCallback(() => {
    focusPending.current = null
  }, [])

  // Re-anchor on every explicit arrival (`arrivalSeq` bumps even when ⌘D is
  // pressed while already on today — the router clears the entry's saved
  // offset for that case). A back/forward-restored entry carries its offset;
  // a fresh navigation anchors to the target day.
  useEffect(() => {
    const restored = savedScroll()
    if (restored !== null) {
      // A restored arrival also cancels any focus still pending from a prior
      // navigation the user backed out of before that day's editor mounted —
      // the day would otherwise steal focus when its row scrolls into view.
      focusPending.current = null
      virtualizer.scrollToOffset(restored)
      return
    }
    focusPending.current = targetDate
    virtualizer.scrollToIndex(indexOfDate(window, targetDate), { align: 'start' })
    // entryId: back/forward between e.g. a `today` entry and a `daily` entry of
    // the same calendar day changes neither targetDate nor arrivalSeq, but each
    // entry carries its own scroll offset to reapply.
  }, [arrivalSeq, entryId, targetDate, window, virtualizer, savedScroll])

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto px-6"
      onScroll={(event) => saveScrollState(event.currentTarget.scrollTop)}
    >
      <div
        className="relative mx-auto w-full max-w-2xl"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const date = dateAtIndex(window, item.index)
          const isToday = date === today
          const autoFocus = focusPending.current === date
          return (
            <div
              key={date}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <section className="border-b border-black/5 py-6 dark:border-white/5">
                <h2 className="mb-3 text-lg font-semibold">
                  {formatDayLabel(date)}
                  {isToday ? (
                    <span className="ml-2 align-middle text-xs font-medium text-[color:var(--accent)]">
                      Today
                    </span>
                  ) : null}
                </h2>
                <NotePane
                  path={dailyPath(date)}
                  lazy
                  autoFocus={autoFocus}
                  onAutoFocused={consumeFocus}
                />
              </section>
            </div>
          )
        })}
      </div>
    </div>
  )
}
