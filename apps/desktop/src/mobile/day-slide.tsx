import { useEffect, useRef, type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { IncomingBacklinks } from '@/mobile/incoming-backlinks'
import { MOBILE_CONTENT_GUTTER } from '@/mobile/mobile-content-gutter'
import { useScrollRestore } from '@/mobile/use-scroll-restore'
import { useSettings } from '@/providers/settings-provider'

interface DaySlideProps {
  /** The slide's ISO day — its daily note path and scroll-memory key. */
  day: string
  /** Today's live ISO date — tints today's date heading, as on desktop. */
  today: string
  /** Whether this slide is the carousel's centered (selected) one. */
  selected: boolean
  /**
   * Shared per-day scroll offsets, owned by the carousel so they outlive this
   * slide (slides beyond the mount radius unmount; V1 preserves each day's
   * scroll position across swipes).
   */
  scrollMemory: Map<string, number>
  /**
   * Bumped on an explicit re-arrival at the shown day (Daily tab or title
   * tapped while already there): the selected slide re-anchors to the top.
   */
  scrollResetSeq: number
  /** True when this slide's editor should focus as soon as its handle exists. */
  focusRequested: boolean
  /** Called after the focus request has been applied. */
  onFocusConsumed: () => void
}

/**
 * One mounted day of the carousel: the date heading (the daily note's subject —
 * chrome, not content, so it is never editable) over the note editor, in its
 * own scroll container. The container records its offset into the carousel's
 * {@link DaySlideProps.scrollMemory} and restores it on remount via
 * {@link useScrollRestore} — the note body loads asynchronously, so
 * restoration re-applies on content growth until the saved offset is
 * reachable, the user takes over, or the deadline passes.
 */
export function DaySlide({
  day,
  today,
  selected,
  scrollMemory,
  scrollResetSeq,
  focusRequested,
  onFocusConsumed,
}: DaySlideProps): ReactElement {
  const { settings } = useSettings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const { handleScroll, resetToTop } = useScrollRestore({
    key: day,
    memory: scrollMemory,
    containerRef,
    contentRef,
  })

  const lastResetSeq = useRef(scrollResetSeq)
  useEffect(() => {
    if (scrollResetSeq === lastResetSeq.current) {
      return
    }
    lastResetSeq.current = scrollResetSeq
    if (!selected) {
      return
    }
    resetToTop()
  }, [scrollResetSeq, selected, resetToTop])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto"
      // Keyboard avoidance is the shell root's job (it ends at the keyboard's
      // top); this only clears the home indicator when the keyboard is down.
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      onScroll={handleScroll}
    >
      <div ref={contentRef}>
        {/* The date is the daily note's subject (V1 / desktop parity) —
            chrome above the editor, formatted per the user's setting,
            tinted on today. Shares the note body's gutter. */}
        <h2
          className={cn(
            'reflect-daily-subject pt-4 pb-1',
            MOBILE_CONTENT_GUTTER,
            day === today && 'text-accent',
          )}
        >
          {formatDayLabel(day, settings.dateFormat)}
        </h2>
        <NotePane
          path={dailyPath(day)}
          lazy
          autoFocus={focusRequested}
          onAutoFocused={onFocusConsumed}
          showBacklinks={false}
          gutterClassName={MOBILE_CONTENT_GUTTER}
          editorClassName="min-h-[60dvh]"
        />
        {/* The mobile section (touch chrome) replaces NotePane's built-in
            desktop panel; a daily-note backlink swipes the carousel to that
            date rather than pushing a screen. */}
        <IncomingBacklinks path={dailyPath(day)} className={cn(MOBILE_CONTENT_GUTTER, 'pb-4')} />
      </div>
    </div>
  )
}
