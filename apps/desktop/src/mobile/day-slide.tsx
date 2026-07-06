import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { IncomingBacklinks } from '@/mobile/incoming-backlinks'
import { MOBILE_CONTENT_GUTTER } from '@/mobile/mobile-content-gutter'
import { useCaretReveal } from '@/mobile/use-caret-reveal'
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
  /**
   * True when this slide's editor should focus as soon as its handle exists —
   * caret at the end of the day's content (the double-tap capture gesture).
   */
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
  const { handleScroll, resetToTop, cancelRestore } = useScrollRestore({
    key: day,
    memory: scrollMemory,
    containerRef,
    contentRef,
  })

  const { revealEnd, cancelReveal } = useCaretReveal({ containerRef, contentRef })

  // The end-of-note autofocus scrolls the caret into view against the
  // full-height viewport; the keyboard then raises and shrinks the shell by
  // its height, dropping the note's end below the fold. The reveal holds the
  // container at its end while that settles (see use-caret-reveal.ts).
  //
  // A remount's scroll restore must die first: the double-tap's second
  // arrival often lands while this slide (freshly remounted from another
  // tab) is still chasing its saved offset, and the chase's next re-apply —
  // delivered after the reveal's pin, on the same content growth — would
  // yank the caret back out of view with nothing re-pinning it.
  const handleAutoFocused = useCallback(() => {
    cancelRestore()
    revealEnd()
    onFocusConsumed()
  }, [cancelRestore, revealEnd, onFocusConsumed])

  const lastResetSeq = useRef(scrollResetSeq)
  useEffect(() => {
    if (scrollResetSeq === lastResetSeq.current) {
      return
    }
    lastResetSeq.current = scrollResetSeq
    if (!selected) {
      return
    }
    if (focusRequested) {
      // A focus arrival (the Daily tab double-tap) anchors to the caret at
      // the note's end — jumping to the top would yank the scroll away from
      // the selection the editor just placed.
      return
    }
    // A reveal still settling from a recent double-tap must die first, or
    // its next re-pin would undo this jump to the top.
    cancelReveal()
    resetToTop()
  }, [scrollResetSeq, selected, focusRequested, cancelReveal, resetToTop])

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
          // V1's double-tap-to-today is a capture gesture: the caret (and the
          // scroll) land at the end of the day's content, ready to append.
          autoFocusSelection="end"
          onAutoFocused={handleAutoFocused}
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
