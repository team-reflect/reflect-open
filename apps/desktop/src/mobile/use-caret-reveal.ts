import { useCallback, useEffect, useRef, type RefObject } from 'react'

/** How long a reveal keeps re-pinning the container to its end. The iOS
 *  keyboard raise (and the shell shrinking by its height) settles well within
 *  a second; past this the user's scrolling owns the position. */
export const REVEAL_WINDOW_MS = 1500

export interface CaretRevealOptions {
  /** The scroll container to hold at its end while the reveal is active. */
  containerRef: RefObject<HTMLElement | null>
  /** The container's content, observed so late growth re-pins too. */
  contentRef: RefObject<HTMLElement | null>
}

export interface CaretReveal {
  /**
   * Scroll the container to its end now and keep it there while the layout
   * settles. The reveal ends when the user touches the container
   * (pointerdown), {@link REVEAL_WINDOW_MS} passes, or the component
   * unmounts; calling it again restarts the window.
   */
  revealEnd: () => void
  /**
   * End an active reveal without touching the scroll position. An explicit
   * re-anchor (the slide's jump-to-top) must call this first — a live reveal
   * would otherwise re-pin to the end on the next resize and undo it.
   */
  cancelReveal: () => void
}

/**
 * Keeps an end-of-note caret visible through the iOS keyboard raise. The
 * editor's own scroll-into-view runs at focus time — against the full-height
 * viewport — but the keyboard reports its height only once it animates up,
 * and the shell then shrinks by that height (Plan 19, decision 8), dropping
 * the note's end below the fold again with nothing re-scrolling. A reveal
 * pins the container to its end and re-pins on every container resize (the
 * keyboard raise, a rotation) or content growth (images sizing in) until the
 * window closes or the user takes over.
 */
export function useCaretReveal({ containerRef, contentRef }: CaretRevealOptions): CaretReveal {
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  const revealEnd = useCallback(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (container === null || content === null) {
      return
    }
    stopRef.current?.()
    let observer: ResizeObserver | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    const pin = (): void => {
      container.scrollTop = container.scrollHeight
    }
    const stop = (): void => {
      if (stopRef.current === stop) {
        stopRef.current = null
      }
      if (deadline !== null) {
        clearTimeout(deadline)
      }
      observer?.disconnect()
      container.removeEventListener('pointerdown', stop)
      container.removeEventListener('scroll', pin)
    }
    stopRef.current = stop
    pin()
    observer = new ResizeObserver(pin)
    observer.observe(container)
    observer.observe(content)
    container.addEventListener('pointerdown', stop, { passive: true })
    // Anything that scrolls the container away mid-reveal loses. Sizes are
    // covered by the observer, but iOS WebKit may scroll the container
    // directly to reveal the newly focused editor — no resize involved. The
    // user's own take-over always leads with a pointerdown (which stops the
    // reveal above), so a scroll arriving here is never the user's.
    container.addEventListener('scroll', pin, { passive: true })
    deadline = setTimeout(stop, REVEAL_WINDOW_MS)
  }, [containerRef, contentRef])

  const cancelReveal = useCallback(() => {
    stopRef.current?.()
  }, [])

  return { revealEnd, cancelReveal }
}
