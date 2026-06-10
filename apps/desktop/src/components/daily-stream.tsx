import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { useToday } from '@/lib/use-today'
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
  // (`dayWindow`, not `window` — shadowing the DOM global here was a footgun.)
  const [dayWindow] = useState(() => createDayWindow(todayIso()))
  const today = useToday()

  const virtualizer = useVirtualizer({
    count: dayWindow.count,
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

  // targetDate is read at arrival time, not reacted to: on the `today` route
  // it drifts when local midnight passes (`todayIso()` per render), and that
  // drift is not a navigation — re-running the effect then would misread the
  // entry's continuously-saved offset as a back/forward restore. The next real
  // arrival (⌘D, a link) reads the fresh value and anchors to the new today.
  const targetDateRef = useRef(targetDate)
  targetDateRef.current = targetDate

  // Re-anchor on every explicit arrival (`arrivalSeq` bumps even when ⌘D is
  // pressed while already on today — the router clears the entry's saved
  // offset for that case; `entryId` covers back/forward between entries whose
  // routes resolve to the same day). A back/forward-restored entry carries its
  // offset; a fresh navigation anchors to the target day.
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
    const target = targetDateRef.current
    focusPending.current = target
    virtualizer.scrollToIndex(indexOfDate(dayWindow, target), { align: 'start' })
  }, [arrivalSeq, entryId, dayWindow, virtualizer, savedScroll])

  return (
    <div
      ref={scrollRef}
      data-testid="daily-stream"
      className="h-full overflow-auto px-6"
      onScroll={(event) => saveScrollState(event.currentTarget.scrollTop)}
      // An explicit click/touch picks its own focus target — a focus still
      // pending for a day whose editor hasn't mounted yet must not steal the
      // caret later. Typing is deliberately not a cancel: ⌘D-then-type should
      // still land focus in today once its editor mounts.
      onPointerDownCapture={() => {
        focusPending.current = null
      }}
    >
      <div
        className="relative mx-auto w-full max-w-2xl"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const date = dateAtIndex(dayWindow, item.index)
          const isToday = date === today
          // V1's daily-note sizing: past days hug their content (an empty day
          // collapses to a short row), while today and future days reserve
          // most of a viewport of writing room. ISO dates compare lexically.
          const isPast = date < today
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
                    <span className="ml-2 align-middle text-xs font-medium text-accent">
                      Today
                    </span>
                  ) : null}
                </h2>
                <NotePane
                  path={dailyPath(date)}
                  lazy
                  autoFocus={autoFocus}
                  onAutoFocused={consumeFocus}
                  editorClassName={isPast ? 'min-h-[200px]' : 'min-h-[60vh]'}
                />
              </section>
            </div>
          )
        })}
      </div>
    </div>
  )
}
