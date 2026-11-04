import { nearestIndex, pageWidth, restOn } from '@/lib/scroll-pager.ts'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'

export interface SnapPagerOptions {
  /**
   * The horizontal scroller. Each child is one page as wide as the scroller.
   */
  element: HTMLElement
  /**
   * The page to rest on when the pager attaches.
   */
  index: number
  count: () => number
  prefersReducedMotion: () => boolean
  /**
   * The shown page changed. A user scroll shows the nearest page, and
   * `show` or `restOn` shows its target at once.
   */
  onIndex: (index: number) => void
  /**
   * A user scroll came to rest on page `index`.
   */
  onUserSettle: (index: number) => void
  signal: AbortSignal
}

export interface SnapPager {
  /**
   * The shown page.
   */
  index: () => number
  /**
   * Scrolls to page `index`, smoothly unless reduced motion is on.
   */
  show: (index: number) => void
  /**
   * Moves onto page `index` at once.
   */
  restOn: (index: number) => void
}

/**
 * Owns the shown page of a snapping horizontal scroller. It rests on the
 * shown page after a scroll that no user started and after a resize, and
 * reports the page a user scroll comes to rest on.
 */
export function attachSnapPager({
  element,
  index: initialIndex,
  count,
  prefersReducedMotion,
  onIndex,
  onUserSettle,
  signal,
}: SnapPagerOptions): SnapPager {
  let index = initialIndex
  // A user scroll has moved the scroller and has not settled.
  let userScrolling = false

  const setIndex = (next: number): void => {
    if (next !== index) {
      index = next
      onIndex(next)
    }
  }

  const show = (next: number): void => {
    setIndex(next)
    userScrolling = false
    element.scrollTo({
      left: next * pageWidth(element),
      behavior: prefersReducedMotion() ? 'instant' : 'smooth',
    })
  }

  const watch = watchScrollSettle({
    element,
    signal,
    onSettle: () => {
      userScrolling = false
      if (!watch.isUserScroll()) {
        restOn(element, index)
        return
      }
      const nearest = nearestIndex(element, count())
      if (nearest === undefined) {
        return
      }
      // WebKit can come to rest between snap points.
      restOn(element, nearest)
      setIndex(nearest)
      onUserSettle(nearest)
    },
  })

  // After the watch, whose own listener decides whether this scroll is the user's.
  element.addEventListener(
    'scroll',
    () => {
      if (!watch.isUserScroll()) {
        return
      }
      userScrolling = true
      const nearest = nearestIndex(element, count())
      if (nearest !== undefined) {
        setIndex(nearest)
      }
    },
    { passive: true, signal },
  )

  // A focused element on another page (keyboard Tab) shows that page.
  element.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      const page = [...element.children].findIndex(
        (child) => target instanceof Node && child.contains(target),
      )
      if (page !== -1 && page !== index) {
        show(page)
      }
    },
    { signal },
  )

  // A rotation or split view changes the page width. Stay on the same page,
  // unless a finger or its momentum owns the position (the settle aligns it).
  const resize = new ResizeObserver(() => {
    if (!watch.isTouching() && !userScrolling) {
      restOn(element, index)
    }
  })
  resize.observe(element)
  signal.addEventListener('abort', () => resize.disconnect(), { once: true })

  restOn(element, index)

  return {
    index: () => index,
    show,
    restOn: (next) => {
      setIndex(next)
      userScrolling = false
      restOn(element, next)
    },
  }
}
