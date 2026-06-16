import { useCallback, useRef } from 'react'

export interface ScrollToIndexBridge {
  /** Scroll a row index into view (a no-op until the owner registers). */
  scrollToIndex: (index: number) => void
  /** The virtualizer's owner registers its `scrollToIndex` here. */
  registerScrollToIndex: (scrollToIndex: (index: number) => void) => void
}

/**
 * A one-way bridge for "scroll row N into view" when the virtualizer lives in a
 * child but the caller (e.g. keyboard navigation) sits in the parent. The child
 * registers its `virtualizer.scrollToIndex`; the parent calls `scrollToIndex`.
 *
 * A virtualized off-screen row isn't in the DOM, so the parent can't reach it
 * with `element.scrollIntoView()` — only the virtualizer's own `scrollToIndex`
 * can window an unmounted row in. Both functions are stable, so passing them
 * across the boundary never re-triggers effects.
 */
export function useScrollToIndexBridge(): ScrollToIndexBridge {
  const scrollToIndexRef = useRef<(index: number) => void>(() => {})
  const registerScrollToIndex = useCallback((scrollToIndex: (index: number) => void) => {
    scrollToIndexRef.current = scrollToIndex
  }, [])
  const scrollToIndex = useCallback((index: number) => scrollToIndexRef.current(index), [])
  return { scrollToIndex, registerScrollToIndex }
}
