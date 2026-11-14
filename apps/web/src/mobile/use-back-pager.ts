import { useEffect, useEffectEvent, useLayoutEffect, type RefObject } from 'react'
import { linkOpacityToScroll } from '@/lib/scroll-linked-opacity.ts'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'

/**
 * How far (px) past the screen edge the pop snap point leaves the current
 * page. The slow end of the release deceleration then runs off screen, and the
 * pop commits as soon as the page leaves the screen.
 */
export const BACK_PAGER_OVERSHOOT_PX = 50

/**
 * Tolerance (px) for comparing scroll offsets, which can be fractional.
 */
const TOLERANCE_PX = 1

/**
 * Scroll offset (px) at or under which the current page is off screen and the
 * lower page fully revealed.
 */
const REVEALED_PX = BACK_PAGER_OVERSHOOT_PX + TOLERANCE_PX

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
  /**
   * Runs with `start` when a user swipe starts to move the current page, and
   * with `cancel` when that swipe settles back on it without a pop.
   */
  onSwipe?: ((phase: 'start' | 'cancel') => void) | undefined
}

/**
 * Rests the scroller on its last page, the end of its scroll range.
 */
function pinToLastPage(scroller: HTMLElement): void {
  scroller.scrollLeft = restLeft(scroller)
}

/**
 * The scroll offset of the last page, the end of the scroll range.
 */
function restLeft(scroller: HTMLElement): number {
  return scroller.scrollWidth - scroller.clientWidth
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
 * The back-swipe as native horizontal scrolling. The browser moves the
 * current page with the finger and snaps it home or off, so the drag never
 * waits for the main thread. A mouse drag from the edge strip scrolls it the
 * same way. Between gestures the scroller rests on the last page; a user
 * swipe that leaves the current page off screen commits the pop. A scroll
 * that stops between the two snap points (a touch that stops the snap does
 * not snap again in WebKit) scrolls on to the nearer one.
 */
export function useBackPager({
  scrollerRef,
  scrimRef,
  edgeRef,
  pagesKey,
  enabled,
  onPop,
  onSwipe,
}: BackPagerOptions): void {
  const pop = useEffectEvent(onPop)
  const reportSwipe = useEffectEvent((phase: 'start' | 'cancel') => onSwipe?.(phase))

  // Before paint, so a changed page list never shows the lower page for a frame.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) {
      pinToLastPage(scroller)
    }
  }, [scrollerRef, pagesKey])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!enabled || !scroller) {
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    let popped = false
    // A user swipe has moved the page and has not settled yet.
    let swiping = false

    // Only a gesture since the pager last rested on its page may pop it: a
    // scroll that code or the engine started is pinned back.
    let gesturesAtRest = 0
    const watch = watchScrollSettle({
      element: scroller,
      onSettle: () => {
        if (popped) {
          return
        }
        const rest = restLeft(scroller)
        if (scroller.scrollLeft >= rest - TOLERANCE_PX) {
          gesturesAtRest = watch.gestures()
          if (swiping) {
            swiping = false
            reportSwipe('cancel')
          }
          return
        }
        if (scroller.scrollLeft > REVEALED_PX) {
          scroller.scrollTo({
            // The midpoint of the part of the travel where the card shows.
            left: scroller.scrollLeft < (BACK_PAGER_OVERSHOOT_PX + rest) / 2 ? 0 : rest,
            behavior: 'smooth',
          })
          return
        }
        if (watch.gestures() === gesturesAtRest) {
          pinToLastPage(scroller)
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

    // A scroll off the last page that a gesture since the last rest made
    // starts a user swipe.
    const startSwipe = (): void => {
      const rest = restLeft(scroller)
      if (
        swiping ||
        popped ||
        watch.gestures() === gesturesAtRest ||
        scroller.scrollLeft >= rest - TOLERANCE_PX
      ) {
        return
      }
      swiping = true
      reportSwipe('start')
    }
    scroller.addEventListener('scroll', startSwipe, { passive: true, signal: controller.signal })

    const scrim = scrimRef.current
    if (scrim) {
      linkOpacityToScroll({ target: scrim, scroller, axis: 'x', from: 0, to: 1, signal })
    }

    // A finger on the pager owns its position, even when the keyboard or the
    // safe area resizes it mid-swipe.
    const resize = new ResizeObserver(() => {
      if (!watch.isTouching() && scroller.scrollLeft > REVEALED_PX) {
        pinToLastPage(scroller)
      }
    })
    resize.observe(scroller)

    return () => {
      controller.abort()
      resize.disconnect()
      if (swiping && !popped) {
        reportSwipe('cancel')
      }
    }
  }, [enabled, scrollerRef, scrimRef, edgeRef, pagesKey])
}
