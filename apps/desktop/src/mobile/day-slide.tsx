import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
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
}

/** How long a remount keeps chasing its saved scroll offset. Local note reads
 *  resolve in milliseconds; past this the offset is treated as unreachable
 *  (the note shrank since it was saved) and the user's scrolling takes over. */
const RESTORE_DEADLINE_MS = 2000

/**
 * One mounted day of the carousel: the date heading (the daily note's subject —
 * chrome, not content, so it is never editable) over the note editor, in its
 * own scroll container. The container records its offset into the carousel's
 * {@link DaySlideProps.scrollMemory} and restores it on remount — the note
 * body loads asynchronously, so restoration re-applies on content growth until
 * the saved offset is reachable, the user takes over, or the deadline passes.
 */
export function DaySlide({
  day,
  today,
  selected,
  scrollMemory,
  scrollResetSeq,
}: DaySlideProps): ReactElement {
  const { settings } = useSettings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // True while a remount restore is converging on the saved offset — scroll
  // events it causes must not overwrite the memory with clamped values.
  const restoringRef = useRef(false)
  // Cancels the in-flight restore, if any — a jump-to-top reset must not race
  // an observer still re-applying the old offset as content grows.
  const stopRestoringRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (container === null || content === null) {
      return
    }
    const saved = scrollMemory.get(day) ?? 0
    if (saved <= 0) {
      return
    }
    restoringRef.current = true
    let observer: ResizeObserver | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    const stop = (): void => {
      restoringRef.current = false
      if (stopRestoringRef.current === stop) {
        stopRestoringRef.current = null
      }
      if (deadline !== null) {
        clearTimeout(deadline)
      }
      observer?.disconnect()
      container.removeEventListener('pointerdown', stop)
    }
    stopRestoringRef.current = stop
    const apply = (): void => {
      container.scrollTop = saved
      if (container.scrollTop >= saved - 1) {
        stop()
      }
    }
    apply()
    if (restoringRef.current) {
      observer = new ResizeObserver(apply)
      observer.observe(content)
      container.addEventListener('pointerdown', stop, { passive: true })
      deadline = setTimeout(stop, RESTORE_DEADLINE_MS)
    }
    return stop
  }, [day, scrollMemory])

  const lastResetSeq = useRef(scrollResetSeq)
  useEffect(() => {
    if (scrollResetSeq === lastResetSeq.current) {
      return
    }
    lastResetSeq.current = scrollResetSeq
    if (!selected) {
      return
    }
    stopRestoringRef.current?.()
    scrollMemory.delete(day)
    if (containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [scrollResetSeq, selected, day, scrollMemory])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto"
      style={{
        paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))',
      }}
      onScroll={(event) => {
        if (!restoringRef.current) {
          scrollMemory.set(day, event.currentTarget.scrollTop)
        }
      }}
    >
      <div ref={contentRef}>
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
    </div>
  )
}
