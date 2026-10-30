import { useEffect, useEffectEvent, useLayoutEffect, type RefObject } from 'react'
import { linkOpacityToScroll } from '@/lib/scroll-linked-opacity.ts'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'

/**
 * Scroll offset (px) at or under which the lower page counts as fully revealed.
 */
const REVEALED_PX = 1

export interface BackPagerOptions {
  /**
   * The horizontal scroller. Its pages are the stack layers, the current one last.
   */
  scrollerRef: RefObject<HTMLElement | null>
  /**
   * The current page's scrim, dimmed by the scroll offset.
   */
  scrimRef: RefObject<HTMLElement | null>
  /**
   * The current page's edge strip, where a mouse drag may start.
   */
  edgeRef: RefObject<HTMLElement | null>
  /**
   * How many pages the scroller holds.
   */
  pageCount: number
  /**
   * Changes whenever the page list changes.
   */
  pagesKey: string
  /**
   * True while a finger or a mouse may swipe the current page away.
   */
  enabled: boolean
  /**
   * Commits the pop. Runs once a user swipe settles on the lower page.
   */
  onPop: () => void
}

function pinToLastPage(scroller: HTMLElement, pageCount: number): void {
  scroller.scrollLeft = (pageCount - 1) * scroller.clientWidth
}

/**
 * Lets the revealed page take taps before React re-renders it as current.
 */
function revealBelow(scroller: HTMLElement): void {
  const below = scroller.querySelector<HTMLElement>(':scope > [data-stack-role="below"]')
  below?.removeAttribute('inert')
  below?.removeAttribute('aria-hidden')
}

/**
 * The edge back-swipe as native horizontal scrolling. The browser moves the
 * current page with the finger and snaps it home or off, so the drag never
 * waits for the main thread. A mouse drag from the edge strip scrolls it the
 * same way. Between gestures the scroller rests on the last page; a user
 * swipe that settles on the first page commits the pop.
 */
export function useBackPager({
  scrollerRef,
  scrimRef,
  edgeRef,
  pageCount,
  pagesKey,
  enabled,
  onPop,
}: BackPagerOptions): void {
  const pop = useEffectEvent(onPop)

  // Before paint, so a changed page list never shows the lower page for a frame.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) {
      pinToLastPage(scroller, pageCount)
    }
  }, [scrollerRef, pageCount, pagesKey])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!enabled || !scroller) {
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    let popped = false

    const watch = watchScrollSettle({
      element: scroller,
      onSettle: () => {
        if (popped) {
          return
        }
        if (!watch.isUserScroll()) {
          pinToLastPage(scroller, pageCount)
          return
        }
        if (scroller.scrollLeft > REVEALED_PX) {
          return
        }
        popped = true
        revealBelow(scroller)
        pop()
      },
      signal,
      isSettled: () => scroller.scrollLeft <= REVEALED_PX,
      dragHandle: edgeRef.current ?? undefined,
    })

    const scrim = scrimRef.current
    if (scrim) {
      linkOpacityToScroll({ target: scrim, scroller, axis: 'x', from: 0, to: 1, signal })
    }

    const resize = new ResizeObserver(() => {
      if (scroller.scrollLeft > REVEALED_PX) {
        pinToLastPage(scroller, pageCount)
      }
    })
    resize.observe(scroller)

    return () => {
      controller.abort()
      resize.disconnect()
    }
  }, [enabled, scrollerRef, scrimRef, edgeRef, pageCount, pagesKey])
}
