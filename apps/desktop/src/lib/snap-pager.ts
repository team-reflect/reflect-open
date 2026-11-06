import { nearestIndex, pageOf, pageWidth, restOn } from '@/lib/scroll-pager.ts'
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
   * Where a mouse drag may start, or `null` for no mouse drag. Defaults to
   * `element`.
   */
  dragHandle?: HTMLElement | null | undefined
  /**
   * The shown page changed. A scroll shows the nearest page (`byScroll` is
   * true), and `show` or `restOn` shows its target at once.
   */
  onIndex: (index: number, byScroll: boolean) => void
  /**
   * A scroll came to rest on page `index`, other than the page `show` targets.
   */
  onSettle: (index: number) => void
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
 * Owns the shown page of a snapping horizontal scroller. The page the
 * scroller rests on is the shown page, whoever moved it there: the pager
 * follows every scroll, reports where it settles, stays on the shown page
 * after a resize, and shows the page of an element that takes focus. A scroll
 * that comes to rest on the page `show` targets counts as `show`'s, even when
 * a finger or wheel moved the scroller on the way.
 */
export function attachSnapPager({
  element,
  index: initialIndex,
  count,
  prefersReducedMotion,
  dragHandle,
  onIndex,
  onSettle,
  signal,
}: SnapPagerOptions): SnapPager {
  let index = initialIndex
  // The scroller is off its page: a scroll moved it between pages and has not
  // settled. A scroll that lands on the page at once (a `restOn`) leaves it
  // false, so it never blocks the focus or resize handling below.
  let scrolling = false
  // The page a running `show` scroll moves to.
  let expected: number | undefined
  // The page width the scroller last rested at. A change means a rotation or
  // split view moved the scroller off its page: stay on the page.
  let width = pageWidth(element)
  const realign = (): boolean => {
    const current = pageWidth(element)
    if (current === width) {
      return false
    }
    width = current
    // A finger or a running scroll owns the position: the settle adopts the
    // page it rests on.
    if (!watch.isTouching() && !scrolling) {
      restOn(element, index)
    }
    return true
  }

  const setIndex = (next: number, byScroll: boolean): void => {
    if (next !== index) {
      index = next
      onIndex(next, byScroll)
    }
  }

  const show = (next: number): void => {
    setIndex(next, false)
    scrolling = false
    const left = next * pageWidth(element)
    if (Math.abs(element.scrollLeft - left) < 1) {
      return
    }
    expected = next
    element.scrollTo({ left, behavior: prefersReducedMotion() ? 'instant' : 'smooth' })
  }

  const watch = watchScrollSettle({
    element,
    signal,
    dragHandle,
    onSettle: () => {
      scrolling = false
      // A width change since the last rest leaves the position stale, so the
      // nearest page would be wrong: stay on the shown page instead.
      if (realign()) {
        return
      }
      const nearest = nearestIndex(element, count())
      const target = expected
      expected = undefined
      if (nearest === undefined) {
        return
      }
      if (nearest === target) {
        restOn(element, index)
        return
      }
      // WebKit can come to rest between snap points.
      restOn(element, nearest)
      setIndex(nearest, true)
      onSettle(nearest)
    },
  })

  element.addEventListener(
    'scroll',
    () => {
      if (expected !== undefined || realign()) {
        return
      }
      const nearest = nearestIndex(element, count())
      if (nearest === undefined) {
        return
      }
      setIndex(nearest, true)
      scrolling = Math.abs(element.scrollLeft - nearest * width) >= 1
    },
    { passive: true, signal },
  )

  // A focused element on another page (keyboard Tab) shows that page.
  element.addEventListener(
    'focusin',
    (event) => {
      if (scrolling) {
        return
      }
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      const page = pageOf(element, target, count())
      if (page !== undefined && page !== index) {
        show(page)
      }
    },
    { signal },
  )

  // The `scroll` the width change causes usually realigns first; this covers
  // a width change that moves nothing, and a height-only resize.
  const resize = new ResizeObserver(() => {
    if (!realign() && !watch.isTouching() && !scrolling) {
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
      setIndex(next, false)
      scrolling = false
      expected = undefined
      restOn(element, next)
    },
  }
}
