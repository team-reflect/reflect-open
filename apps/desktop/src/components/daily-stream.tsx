import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { useToday } from '@/lib/use-today'
import { createDayWindow, dateAtIndex, indexOfDate, neighborDate } from '@/lib/day-window'
import { useSetFocusedDailyDate } from '@/providers/focused-daily-provider'
import { useRouter } from '@/routing/router'

interface DailyStreamProps {
  /** The day to anchor/scroll to (from the `today` or `daily/:date` route). */
  targetDate: string
}

/**
 * The stream's horizontal gutter: the old scroll-container `px-6` and centered
 * `max-w-2xl` column folded into one `padding-inline`, applied *inside* each
 * row's elements (day label, editor, pane chrome) instead of around the rows.
 * Rows and the dividers between them span the pane's full width, and because
 * the editor's share of the gutter is its own padding, clicking anywhere
 * across the row focuses that day's note.
 *
 * An ordinary class (styles/index.css), not a `px-*` utility: on the editor it
 * must out-cascade the un-layered `.reflect-editor` padding reset, which every
 * `@layer utilities` rule loses to regardless of order.
 */
const STREAM_GUTTER = 'reflect-stream-gutter'

/**
 * The size guess for unmounted rows — also the unit for the mount-time anchor
 * offset, so `initialOffset` lands exactly where `scrollToIndex` would before
 * any row has been measured.
 */
export const ESTIMATED_DAY_HEIGHT = 220

/**
 * Compensate the scroll position whenever a row **above** the viewport changes
 * size, unconditionally. Days mount as a short loading placeholder and grow
 * when their note arrives, so every load above the anchor would otherwise push
 * the viewport's content down the stream — a fresh "Today" navigation lands
 * days off target. The library default skips compensation while the last
 * scroll direction is backward, which is exactly the state the anchor scroll's
 * own downward adjustments leave us in when those loads complete.
 */
function adjustScrollForResizeAboveViewport(
  item: VirtualItem,
  _delta: number,
  instance: Virtualizer<HTMLDivElement, Element>,
): boolean {
  return item.start < (instance.scrollOffset ?? 0)
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
  const { settings } = useSettings()

  // targetDate is read at arrival time, not reacted to: on the `today` route
  // it drifts when local midnight passes (`todayIso()` per render), and that
  // drift is not a navigation — re-running the anchor effect then would
  // misread the entry's continuously-saved offset as a back/forward restore.
  // The next real arrival (⌘D, a link) reads the fresh value and anchors to
  // the new today.
  const targetDateRef = useRef(targetDate)
  targetDateRef.current = targetDate

  const virtualizer = useVirtualizer({
    count: dayWindow.count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_DAY_HEIGHT,
    overscan: 2,
    paddingEnd: 240,
    // Write each row's transform and the sizer's height straight to the DOM
    // inside the virtualizer's `onChange`, synchronously, in the same tick as
    // the scroll compensation a resize triggers.
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
    // The mount-time anchor. The virtualizer applies this to the scroll
    // element inside its own layout effect — before first paint — so the
    // stream never paints the top of the window and then visibly lurches
    // down to the target day, and it decides which rows the first render
    // mounts at all. A remount of an entry the user navigated back to
    // restores its saved offset the same jump-free way.
    initialOffset: () =>
      savedScroll() ?? indexOfDate(dayWindow, targetDateRef.current) * ESTIMATED_DAY_HEIGHT,
  })
  // An instance field, not an option — reassigning every render is idempotent.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjustScrollForResizeAboveViewport

  // Only the day navigated to receives focus, once per navigation — a row that
  // scrolls offscreen and back must not steal focus from wherever the user is.
  // The flag is consumed when the editor actually mounts and focuses (not at
  // render time), so a virtualizer re-render before the lazy load completes
  // can't drop the focus.
  const focusPending = useRef<string | null>(null)
  const consumeFocus = useCallback(() => {
    focusPending.current = null
  }, [])

  // Report the day the user is editing to the context sidebar: the route stays
  // on the day navigated to, but focus moves freely between stream rows, and the
  // sidebar's note actions / published link must describe the focused day.
  const setFocusedDailyDate = useSetFocusedDailyDate()

  // Cross-note arrow navigation (ArrowUp at the top of a day -> end of the
  // previous day; ArrowDown at the bottom -> start of the next day). The stream
  // is virtualized, so the neighbor day's editor may not be mounted: we keep a
  // registry of mounted day handles plus a single pending-focus slot that
  // carries the target caret position, applied when the neighbor row mounts and
  // registers. This is independent of the `⌘D` autofocus path (`focusPending`).
  const dayHandlesRef = useRef(new Map<string, NoteEditorHandle>())
  const pendingFocusRef = useRef<{ date: string; position: 'start' | 'end' } | null>(null)

  const focusDay = useCallback((handle: NoteEditorHandle, position: 'start' | 'end') => {
    handle.focus()
    // meowdown's setSelection also scrolls the caret into view.
    handle.setSelection(position)
  }, [])

  const registerHandle = useCallback(
    (date: string, handle: NoteEditorHandle | null) => {
      if (handle === null) {
        dayHandlesRef.current.delete(date)
        return
      }
      dayHandlesRef.current.set(date, handle)
      const pending = pendingFocusRef.current
      if (pending?.date === date) {
        pendingFocusRef.current = null
        focusDay(handle, pending.position)
      }
    },
    [focusDay],
  )

  const handleExitBoundary = useCallback(
    (date: string, direction: 'up' | 'down'): boolean => {
      const target = neighborDate(dayWindow, date, direction === 'up' ? -1 : 1)
      if (target === null) {
        // Window edge: no neighbor — hand the key back so the editor no-ops.
        return false
      }
      const position: 'start' | 'end' = direction === 'up' ? 'end' : 'start'
      const mounted = dayHandlesRef.current.get(target)
      if (mounted) {
        focusDay(mounted, position)
        return true
      }
      // The neighbor is virtualized away: queue the focus, then scroll its row
      // into the rendered range so it mounts and `registerHandle` applies it.
      pendingFocusRef.current = { date: target, position }
      virtualizer.scrollToIndex(indexOfDate(dayWindow, target), {
        align: direction === 'up' ? 'end' : 'start',
      })
      return true
    },
    [dayWindow, virtualizer, focusDay],
  )

  // Re-anchor on every explicit arrival (`arrivalSeq` bumps even when ⌘D is
  // pressed while already on today — the router clears the entry's saved
  // offset for that case; `entryId` covers back/forward between entries whose
  // routes resolve to the same day). A back/forward-restored entry carries its
  // offset; a fresh navigation anchors to the target day.
  //
  // A layout effect, not a passive one: rows measure during the mount commit
  // itself — their `measureElement` refs fire before the virtualizer's own
  // layout effect has attached the scroll element, so its above-viewport
  // resize compensation is a silent no-op — and that moves the target day's
  // true start away from the estimate-derived `initialOffset` before first
  // paint. A post-paint anchor let that mis-anchored frame become visible: a
  // one-frame flicker on every entry into the stream. Anchoring in the layout
  // phase installs `scrollToIndex`'s index-pinning reconcile (rAF, still
  // pre-paint), which pins the target day to the viewport top before the
  // frame is shown and holds it there while the surrounding rows measure in.
  useLayoutEffect(() => {
    const restored = savedScroll()
    if (restored !== null) {
      // A restored arrival also cancels any focus still pending from a prior
      // navigation the user backed out of before that day's editor mounted (both
      // the ⌘D autofocus and a queued cross-note boundary focus). The day would
      // otherwise steal focus when its row scrolls into view.
      focusPending.current = null
      pendingFocusRef.current = null
      virtualizer.scrollToOffset(restored)
      return
    }
    const target = targetDateRef.current
    pendingFocusRef.current = null
    focusPending.current = target
    virtualizer.scrollToIndex(indexOfDate(dayWindow, target), { align: 'start' })
  }, [arrivalSeq, entryId, dayWindow, virtualizer, savedScroll])

  return (
    <div
      ref={scrollRef}
      data-testid="daily-stream"
      className="h-full overflow-auto"
      onScroll={(event) => saveScrollState(event.currentTarget.scrollTop)}
      // An explicit click/touch picks its own focus target — a focus still
      // pending for a day whose editor hasn't mounted yet must not steal the
      // caret later. Typing is deliberately not a cancel: ⌘D-then-type should
      // still land focus in today once its editor mounts.
      onPointerDownCapture={() => {
        focusPending.current = null
        pendingFocusRef.current = null
      }}
    >
      <div ref={virtualizer.containerRef} className="relative w-full">
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
              className="absolute inset-x-0 top-0"
              // Focus entering this row (clicking its editor, tabbing in) makes
              // it the day the sidebar describes.
              onFocusCapture={() => setFocusedDailyDate(date)}
            >
              <section className="border-b border-border py-6">
                {/* V1 renders the date as the note's H1-sized subject, with
                    today's tinted brand (its `highlightSubject`). */}
                <h2
                  className={cn(
                    'reflect-daily-subject mb-3',
                    STREAM_GUTTER,
                    isToday && 'text-accent',
                  )}
                >
                  {formatDayLabel(date, settings.dateFormat)}
                </h2>
                <NotePane
                  path={dailyPath(date)}
                  dailyDate={date}
                  registerHandle={registerHandle}
                  onExitBoundary={handleExitBoundary}
                  lazy
                  autoFocus={autoFocus}
                  onAutoFocused={consumeFocus}
                  gutterClassName={STREAM_GUTTER}
                  editorClassName={isPast ? 'min-h-[100px]' : 'min-h-[60vh]'}
                />
              </section>
            </div>
          )
        })}
      </div>
    </div>
  )
}
