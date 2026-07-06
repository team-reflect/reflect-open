import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react'

/** How long a remount keeps chasing its saved scroll offset. Local note reads
 *  resolve in milliseconds; past this the offset is treated as unreachable
 *  (the content shrank since it was saved) and the user's scrolling takes over. */
export const RESTORE_DEADLINE_MS = 2000

export interface ScrollRestoreOptions {
  /** The saved offset's key in `memory` (e.g. the slide's ISO day). */
  key: string
  /**
   * Shared offset store, owned by the caller so it outlives this container
   * (carousel slides beyond the mount radius unmount; V1 preserves each day's
   * scroll position across swipes).
   */
  memory: Map<string, number>
  /** The scroll container whose offset is recorded and restored. */
  containerRef: RefObject<HTMLElement | null>
  /** The container's content, observed so the restore re-applies as it grows. */
  contentRef: RefObject<HTMLElement | null>
}

export interface ScrollRestore {
  /**
   * Attach as the container's `onScroll`: records the offset into `memory` —
   * except while a restore is converging, whose clamped intermediate scrolls
   * must not overwrite the saved offset.
   */
  handleScroll: (event: UIEvent<HTMLElement>) => void
  /** Cancel any in-flight restore, forget the saved offset, and jump to the top. */
  resetToTop: () => void
  /**
   * End an in-flight restore without touching the scroll position or the
   * saved offset. An end-of-note focus arrival (the Daily-tab double-tap)
   * must call this before pinning the container to its end — the chase would
   * otherwise re-apply the stale offset on the next content growth and yank
   * the caret back out of view.
   */
  cancelRestore: () => void
}

/**
 * Remount scroll restoration for an asynchronously-filling container: on mount
 * the saved offset is re-applied on every content growth until it is reachable
 * — a single scroll would be clamped away while the content is still short.
 * The chase ends when the offset is reached, the user touches the container
 * (pointerdown), {@link ScrollRestore.resetToTop} intervenes, or
 * {@link RESTORE_DEADLINE_MS} passes.
 */
export function useScrollRestore({
  key,
  memory,
  containerRef,
  contentRef,
}: ScrollRestoreOptions): ScrollRestore {
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
    const saved = memory.get(key) ?? 0
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
  }, [key, memory, containerRef, contentRef])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!restoringRef.current) {
        memory.set(key, event.currentTarget.scrollTop)
      }
    },
    [key, memory],
  )

  const resetToTop = useCallback(() => {
    stopRestoringRef.current?.()
    memory.delete(key)
    if (containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [key, memory, containerRef])

  const cancelRestore = useCallback(() => {
    stopRestoringRef.current?.()
  }, [])

  return { handleScroll, resetToTop, cancelRestore }
}
